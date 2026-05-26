import {
  LucidEvolution,
  UTxO,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  treasuryValidator,
  groupValidator,
  alwaysFailsValidator,
} from "../core/validators/constants.js";
import { DcuError, SetupError } from "../core/errors.js";
import { ScriptRefOutRef } from "./deployScripts.js";

export type VerifyDeploymentConfig = {
  treasuryRef: ScriptRefOutRef;
  groupRef: ScriptRefOutRef;
};

export type VerifyDeploymentResult = {
  ok: boolean;
  treasuryUtxo: UTxO | null;
  groupUtxo: UTxO | null;
  /** Human-readable issues found, empty when ok === true. */
  issues: string[];
};

/**
 * Verifies that deployed reference scripts are still on-chain and hold the
 * expected validator scripts.
 *
 * Checks performed:
 * - Both UTxOs exist at the expected outRefs.
 * - Each UTxO is at the alwaysFails deployment address.
 * - Each UTxO carries a `scriptRef` (non-null).
 * - The `scriptRef` matches the current compiled script CBOR.
 *
 * A failed check means `ok: false` with a descriptive `issues` array.
 * This does NOT throw — callers can inspect the result and decide.
 *
 * @param lucid  - Lucid instance (any wallet, read-only query).
 * @param config - The OutRefs returned by `deployScripts`.
 * @returns Effect yielding `VerifyDeploymentResult`.
 */
export const verifyDeployment = (
  lucid: LucidEvolution,
  config: VerifyDeploymentConfig,
): Effect.Effect<VerifyDeploymentResult, DcuError, never> =>
  Effect.gen(function* () {
    const { treasuryRef, groupRef } = config;

    const network = lucid.config().network!;
    const deployAddress = validatorToAddress(
      network,
      alwaysFailsValidator.elseAlwaysFails,
    );

    const [tUtxo, gUtxo] = yield* Effect.tryPromise({
      try: () =>
        lucid.utxosByOutRef([
          { txHash: treasuryRef.txHash, outputIndex: treasuryRef.outputIndex },
          { txHash: groupRef.txHash, outputIndex: groupRef.outputIndex },
        ]),
      catch: (e) =>
        new SetupError({
          message: `verifyDeployment: utxos query failed: ${e}`,
        }),
    });

    const issues: string[] = [];

    const treasury = tUtxo ?? null;
    const group = gUtxo ?? null;

    if (!treasury) {
      issues.push(
        `Treasury ref UTxO not found: ${treasuryRef.txHash}#${treasuryRef.outputIndex}`,
      );
    } else {
      if (treasury.address !== deployAddress)
        issues.push(`Treasury UTxO is at wrong address: ${treasury.address}`);
      if (!treasury.scriptRef) issues.push("Treasury UTxO has no scriptRef");
      else if (
        treasury.scriptRef.script !== treasuryValidator.mintTreasury.script
      )
        issues.push(
          "Treasury scriptRef CBOR does not match current compiled validator — contracts upgraded?",
        );
    }

    if (!group) {
      issues.push(
        `Group ref UTxO not found: ${groupRef.txHash}#${groupRef.outputIndex}`,
      );
    } else {
      if (group.address !== deployAddress)
        issues.push(`Group UTxO is at wrong address: ${group.address}`);
      if (!group.scriptRef) issues.push("Group UTxO has no scriptRef");
      else if (group.scriptRef.script !== groupValidator.spendGroup.script)
        issues.push(
          "Group scriptRef CBOR does not match current compiled validator — contracts upgraded?",
        );
    }

    return {
      ok: issues.length === 0,
      treasuryUtxo: treasury,
      groupUtxo: group,
      issues,
    };
  });
