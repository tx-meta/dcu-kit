import {
  Constr,
  Data,
  LucidEvolution,
  Network,
  Script,
  TxBuilder,
  UTxO,
  validatorToAddress,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { Effect } from "effect";
import {
  ConfigurationError,
  LucidError,
  UtxoNotFoundError,
} from "../core/errors.js";
import {
  getUtxosAt,
  parseSafeDatum,
  patchInlineDatum,
  resolveUtxoByUnit,
  sortUtxos,
} from "../core/utils/index.js";
import { EscrowDatum, EscrowDatumSchema } from "./types.js";
import { escrowPolicyId, escrowValidator } from "./validators.js";

/** The escrow script address for a network (no stake credential — spec 3.3). */
export const escrowAddress = (network: Network): string =>
  validatorToAddress(network, escrowValidator.spendEscrow);

/**
 * Derives the escrow state-token name from its seed UTxO.
 *
 * Matches the Aiken on-chain algorithm (`escrow/credential.state_token_name`):
 * full 32-byte blake2b_256 of the CBOR-serialised OutputReference — no CIP-68
 * prefix, no truncation (a single state token, not a ref/user pair).
 */
export const escrowStateTokenName = (seed: UTxO): Effect.Effect<string> =>
  Effect.sync(() => {
    const outputRefCbor = Data.to(
      new Constr(0, [seed.txHash, BigInt(seed.outputIndex)]),
    );
    return bytesToHex(blake2b(hexToBytes(outputRefCbor), { dkLen: 32 }));
  });

/** Resolves a live escrow by its state-token name and parses its datum. */
export const resolveEscrow = (
  lucid: LucidEvolution,
  stateTokenName: string,
): Effect.Effect<
  { utxo: UTxO; datum: EscrowDatum },
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const unit = escrowPolicyId + stateTokenName;
    const utxoRaw = yield* resolveUtxoByUnit(lucid, unit);
    const utxo = patchInlineDatum(utxoRaw);
    const datum = (yield* parseSafeDatum(utxo.datum, EscrowDatumSchema).pipe(
      Effect.mapError(
        (e) =>
          new ConfigurationError({
            configKey: "stateTokenName",
            message: `UTxO holding ${unit} has no valid escrow datum: ${String(e)}`,
          }),
      ),
    )) as unknown as EscrowDatum;
    return { utxo, datum };
  });

/**
 * Witness options for a party whose credential may be a script (e.g. multisig).
 * VK parties need neither field — the endpoint adds their signer key from the datum.
 */
export type PartyWitness = {
  /** The script preimage when the party credential is a script hash. */
  script?: Script;
  /** Key hashes that will sign (native `atLeast` members, or extra signers). */
  signerKeyHashes?: string[];
};

/**
 * Satisfies `credential_authorized` for one party.
 *
 * VK credential: adds the datum's key hash as a required signer.
 * Script credential: spends a dust UTxO at the script address and pays it back
 * (the on-chain rule is "some spent input sits at that script"), attaches the
 * provided script, and adds the quorum's signer keys.
 */
export const applyPartyWitness = (
  lucid: LucidEvolution,
  tx: TxBuilder,
  credential: EscrowDatum["verifier"],
  witness: PartyWitness | undefined,
  party: string,
): Effect.Effect<TxBuilder, ConfigurationError | LucidError, never> =>
  Effect.gen(function* () {
    if ("VerificationKey" in credential) {
      return tx.addSignerKey(credential.VerificationKey[0]);
    }
    const scriptHash = credential.Script[0];
    if (!witness?.script) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: `${party}Witness.script`,
          message: `${party} is a script credential (${scriptHash}); pass its script preimage`,
        }),
      );
    }
    if (validatorToScriptHash(witness.script) !== scriptHash) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: `${party}Witness.script`,
          message: `provided script hashes to ${validatorToScriptHash(witness.script)}, datum expects ${scriptHash}`,
        }),
      );
    }
    const network = lucid.config().network ?? "Preprod";
    const scriptAddr = validatorToAddress(network, witness.script);
    const dustCandidates = sortUtxos(yield* getUtxosAt(lucid, scriptAddr));
    const dust = dustCandidates[0];
    if (!dust) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: `${party}Witness`,
          message: `no UTxO at ${scriptAddr} to prove the ${party} script — fund a small (dust) UTxO at the script address first`,
        }),
      );
    }
    const withDust = tx
      .collectFrom([dust])
      .attach.SpendingValidator(witness.script)
      .pay.ToAddress(dust.address, dust.assets);
    return (witness.signerKeyHashes ?? []).reduce(
      (t, kh) => t.addSignerKey(kh),
      withDust,
    );
  });

/** The escrowed asset's Lucid unit ("lovelace" for ADA). */
export const escrowAssetUnit = (datum: EscrowDatum): string =>
  datum.asset_policy === ""
    ? "lovelace"
    : datum.asset_policy + datum.asset_name;
