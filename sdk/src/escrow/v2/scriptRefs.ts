import {
  type Script,
  type TxBuilder,
  type UTxO,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { ReferenceScriptMismatchError } from "../../core/errors.js";
import {
  escrowV2Validator,
  poolVaultValidator,
  projectValidator,
} from "./validators.js";

/**
 * Reference-script UTxOs for the three escrow v2 validators. When supplied, an
 * endpoint witnesses the validator from the on-chain UTxO via `readFrom`
 * instead of inlining its bytes, which is what keeps a transaction under the
 * 16 KB limit.
 *
 * Plural (`scriptRefs`) matches the ROSCA and governance convention; savings
 * stays singular (`scriptRef`) because it has exactly one validator.
 *
 * These are fully-resolved `UTxO`s carrying `scriptRef`, as produced by the
 * admin `deployModuleScripts` flow, not bare out-refs.
 *
 * The escrow validator is the one that matters: at 11.4 KB it is the reason
 * `allocateToEscrow` cannot inline both scripts. Pool (4.1 KB) and project
 * (2.3 KB) fit inline comfortably, so their refs are pure headroom.
 */
export type EscrowV2ScriptRefs = {
  /** escrow_v2_validator, 11.4 KB. */
  escrow?: UTxO;
  /** pool_vault_validator, 4.1 KB. */
  pool?: UTxO;
  /** project_validator, 2.3 KB. */
  project?: UTxO;
};

/** Which escrow v2 validator a reference or attachment refers to. */
export type EscrowV2Validator = "escrow" | "pool" | "project";

/**
 * Each validator's compiled script. Aiken emits ONE script per multi-handler
 * validator, so `spend` and `mint` share a hash — a single reference UTxO
 * witnesses both purposes, and `readFrom` is therefore called once.
 */
const SCRIPT: Record<EscrowV2Validator, { spend: Script; mint: Script }> = {
  escrow: {
    spend: escrowV2Validator.spendEscrow,
    mint: escrowV2Validator.mintEscrow,
  },
  pool: {
    spend: poolVaultValidator.spendPool,
    mint: poolVaultValidator.mintPool,
  },
  project: {
    spend: projectValidator.spendProject,
    mint: projectValidator.mintProject,
  },
};

/** The error taxonomy's name for each validator. */
const VALIDATOR_ERROR_KEY = {
  escrow: "escrowV2",
  pool: "pool",
  project: "project",
} as const;

// ─── Session default ─────────────────────────────────────────────────────────
// Mirrors `configureReferenceScripts` for ROSCA: set the deployed refs once
// instead of threading them through every endpoint call. Per-call config wins.

let sessionRefs: EscrowV2ScriptRefs | undefined;

/**
 * Sets the session-default escrow v2 reference scripts used by every endpoint
 * that takes a `scriptRefs` config field when that call does not pass its own.
 *
 * @example
 * const { refs } = await Effect.runPromise(deployModuleScripts({ escrowV2 }, lucid));
 * const [utxo] = await lucid.utxosByOutRef([refs.escrowV2!]);
 * configureEscrowV2ReferenceScripts({ escrow: utxo });
 */
export const configureEscrowV2ReferenceScripts = (
  refs: EscrowV2ScriptRefs,
): void => {
  sessionRefs = refs;
};

/** Clears any session-default escrow v2 reference scripts (back to inline). */
export const clearEscrowV2ReferenceScripts = (): void => {
  sessionRefs = undefined;
};

/** Returns the current session-default escrow v2 reference scripts, if any. */
export const getEscrowV2SessionReferenceScripts = ():
  EscrowV2ScriptRefs | undefined => sessionRefs;

/** Per-call refs when given, otherwise the session default, otherwise inline. */
export const effectiveEscrowV2ScriptRefs = (
  perCall?: EscrowV2ScriptRefs,
): EscrowV2ScriptRefs => {
  const hasAny = (r?: EscrowV2ScriptRefs) =>
    !!r && (!!r.escrow || !!r.pool || !!r.project);
  if (hasAny(perCall)) return perCall!;
  return sessionRefs ?? {};
};

/**
 * Verifies that each supplied reference-script UTxO carries a `scriptRef` whose
 * hash matches the compiled validator. Turns the otherwise cryptic on-chain
 * "script hash mismatch" ledger failure into a typed, early error.
 *
 * Only checks the refs that are present; absent refs (the inline path) are fine.
 */
export const verifyEscrowV2ScriptRefs = (
  refs: EscrowV2ScriptRefs,
): Effect.Effect<void, ReferenceScriptMismatchError, never> =>
  Effect.gen(function* () {
    for (const which of ["escrow", "pool", "project"] as const) {
      const utxo = refs[which];
      if (!utxo) continue;
      const expectedHash = validatorToScriptHash(SCRIPT[which].spend);
      if (!utxo.scriptRef) {
        return yield* Effect.fail(
          new ReferenceScriptMismatchError({
            validator: VALIDATOR_ERROR_KEY[which],
            expectedHash,
            actualHash: "none",
            reason: `escrow v2 ${which} reference UTxO ${utxo.txHash}#${utxo.outputIndex} carries no script reference`,
          }),
        );
      }
      const actualHash = validatorToScriptHash(utxo.scriptRef);
      if (actualHash !== expectedHash) {
        return yield* Effect.fail(
          new ReferenceScriptMismatchError({
            validator: VALIDATOR_ERROR_KEY[which],
            expectedHash,
            actualHash,
            reason: `escrow v2 ${which} reference UTxO ${utxo.txHash}#${utxo.outputIndex} carries a different validator`,
          }),
        );
      }
    }
  });

/**
 * Witnesses one escrow v2 validator on a transaction: from its reference-script
 * UTxO when one was supplied, otherwise by inlining the script bytes.
 *
 * `spend` and `mint` share a compiled script, so a reference is read once no
 * matter how many purposes the transaction exercises.
 *
 * @param tx - The transaction being built.
 * @param which - Which validator to witness.
 * @param refs - The effective reference scripts for this call.
 * @param purposes - The purposes to attach when inlining.
 * @returns The transaction with the validator witnessed.
 */
export const witnessEscrowV2Script = (
  tx: TxBuilder,
  which: EscrowV2Validator,
  refs: EscrowV2ScriptRefs,
  purposes: Array<"spend" | "mint">,
): TxBuilder => {
  const ref = refs[which];
  if (ref) return tx.readFrom([ref]);
  let out = tx;
  for (const purpose of purposes) {
    out =
      purpose === "spend"
        ? out.attach.SpendingValidator(SCRIPT[which].spend)
        : out.attach.MintingPolicy(SCRIPT[which].mint);
  }
  return out;
};
