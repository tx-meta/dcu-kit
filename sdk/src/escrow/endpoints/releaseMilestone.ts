import {
  Assets,
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  TransactionBuildError,
} from "../../core/errors.js";
import { makeReturn } from "../../core/utils/index.js";
import {
  EscrowDatum,
  EscrowMintRedeemer,
  EscrowSpendRedeemer,
  fromOnchainAddress,
} from "../types.js";
import { escrowPolicyId, escrowValidator } from "../validators.js";
import {
  applyPartyWitness,
  escrowAssetUnit,
  PartyWitness,
  resolveEscrow,
} from "../utils.js";

/**
 * Creates an unsigned transaction releasing the next milestone tranche to the
 * beneficiary. Verifier-authorized; strictly before expiry.
 *
 * **Functionality:**
 * - Pays `milestones[released_count]` of the escrowed asset to the beneficiary's
 *   full address (stake credential pinned by the datum).
 * - Non-final: continues the escrow at the same address with `released_count + 1`.
 * - Final tranche: burns the state token; the escrow ends.
 * - VK verifier: the endpoint adds the required signer (the verifier signs the tx).
 *   Script verifier (multisig): pass `verifierWitness` — the endpoint spends and
 *   returns a dust UTxO at the script address (the on-chain authorization proof).
 *
 * @param lucid - Lucid instance with the crank wallet selected (pays the fee).
 * @param config - ReleaseMilestoneConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ReleaseMilestoneConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Required when the verifier credential is a script hash. */
  verifierWitness?: PartyWitness;
};

export const unsignedReleaseMilestoneTxProgram = (
  lucid: LucidEvolution,
  config: ReleaseMilestoneConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrow(
      lucid,
      config.stateTokenName,
    );
    const stateUnit = escrowPolicyId + config.stateTokenName;
    const releasedCount = Number(datum.released_count);
    const tranche = datum.milestones[releasedCount];
    if (tranche === undefined) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message: `all ${datum.milestones.length} milestones already released`,
        }),
      );
    }
    const now = BigInt(Date.now());
    if (now >= datum.expiry) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "expiry",
          message:
            "escrow has expired — releases are closed; the funder can reclaim",
        }),
      );
    }

    const isFinal = releasedCount + 1 === datum.milestones.length;
    const network = lucid.config().network ?? "Preprod";
    const beneficiaryAddress = yield* fromOnchainAddress(
      network,
      datum.beneficiary,
    );

    const assetUnit = escrowAssetUnit(datum);
    const isAda = assetUnit === "lovelace";
    const payoutAssets: Assets = isAda
      ? { lovelace: tranche }
      : { lovelace: 2_000_000n, [assetUnit]: tranche };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            Release: {
              escrow_input_index: inputIndices[0],
              continuation_index: isFinal ? 99n : 0n,
              payout_index: isFinal ? 0n : 1n,
            },
          },
          EscrowSpendRedeemer,
        ),
      inputs: [escrowUtxo],
    };

    // Release requires a pinned upper bound at/before expiry.
    const validTo = Number(
      now + 1_200_000n < datum.expiry ? now + 1_200_000n : datum.expiry,
    );

    const baseTx = lucid
      .newTx()
      .collectFrom([escrowUtxo], redeemer)
      .attach.SpendingValidator(escrowValidator.spendEscrow)
      .validTo(validTo);

    const withOutputs = isFinal
      ? baseTx
          .mintAssets({ [stateUnit]: -1n }, Data.to("BurnEscrow", EscrowMintRedeemer))
          .attach.MintingPolicy(escrowValidator.mintEscrow)
          .pay.ToAddress(beneficiaryAddress, payoutAssets)
      : (() => {
          const continuationAssets: Assets = { ...escrowUtxo.assets };
          continuationAssets[assetUnit] =
            (continuationAssets[assetUnit] ?? 0n) - tranche;
          const updatedDatum: EscrowDatum = {
            ...datum,
            released_count: datum.released_count + 1n,
          };
          return baseTx
            .pay.ToContract(
              escrowUtxo.address,
              { kind: "inline", value: Data.to(updatedDatum, EscrowDatum) },
              continuationAssets,
            )
            .pay.ToAddress(beneficiaryAddress, payoutAssets);
        })();

    const withWitness = yield* applyPartyWitness(
      lucid,
      withOutputs,
      datum.verifier,
      config.verifierWitness,
      "verifier",
    );

    const tx = yield* withWitness.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "releaseMilestone",
            error: String(e),
          }),
      ),
    );

    return tx;
  });

export const releaseMilestone = (
  lucid: LucidEvolution,
  config: ReleaseMilestoneConfig,
) => makeReturn(unsignedReleaseMilestoneTxProgram(lucid, config));
