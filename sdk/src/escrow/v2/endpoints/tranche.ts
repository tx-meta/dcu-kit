import { Assets, Data, TxBuilder, UTxO } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { ConfigurationError } from "../../../core/errors.js";
import { EscrowDatumV2, fromOnchainAddress } from "../types.js";
import { escrowV2PolicyId, escrowV2Validator } from "../validators.js";
import { escrowV2AssetUnit, MIN_ADA_BUFFER } from "../utils.js";
import { EscrowV2MintRedeemer } from "../types.js";

/**
 * Internal: everything Release and TimeoutRelease share — the current tranche,
 * payout / continuation / funder-remainder outputs, and the redeemer indices
 * (non-final: [continuation 0, payout 1]; final: [payout 0, funder 1]).
 */
export const applyTrancheOutputs = (
  network: Parameters<typeof fromOnchainAddress>[0],
  baseTx: TxBuilder,
  escrowUtxo: UTxO,
  datum: EscrowDatumV2,
  stateUnit: string,
): Effect.Effect<
  {
    tx: TxBuilder;
    isFinal: boolean;
    indices: {
      continuation_index: bigint;
      payout_index: bigint;
      funder_index: bigint;
    };
  },
  ConfigurationError
> =>
  Effect.gen(function* () {
    const releasedCount = Number(datum.released_count);
    const milestone = datum.milestones[releasedCount];
    if (milestone === undefined) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message: `all ${datum.milestones.length} milestones already released`,
        }),
      );
    }
    const tranche = milestone.amount;
    const isFinal = releasedCount + 1 === datum.milestones.length;
    const beneficiaryAddress = yield* fromOnchainAddress(
      network,
      datum.beneficiary,
    );
    const funderAddress = yield* fromOnchainAddress(network, datum.funder);

    const assetUnit = escrowV2AssetUnit(datum);
    const isAda = assetUnit === "lovelace";
    const payoutAssets: Assets = isAda
      ? { lovelace: tranche }
      : { lovelace: MIN_ADA_BUFFER, [assetUnit]: tranche };

    if (isFinal) {
      // The remainder (buffer, minus what the token payout's min-ADA consumes)
      // returns to the funder — enforced on-chain in v2.
      const funderRemainder: Assets = { ...escrowUtxo.assets };
      delete funderRemainder[stateUnit];
      funderRemainder[assetUnit] = (funderRemainder[assetUnit] ?? 0n) - tranche;
      if (!isAda) {
        funderRemainder.lovelace =
          (funderRemainder.lovelace ?? 0n) - MIN_ADA_BUFFER;
      }
      for (const [unit, amount] of Object.entries(funderRemainder)) {
        if (amount <= 0n) delete funderRemainder[unit];
      }
      const burnTx = baseTx
        .mintAssets(
          { [stateUnit]: -1n },
          Data.to("BurnEscrowV2", EscrowV2MintRedeemer),
        )
        .attach.MintingPolicy(escrowV2Validator.mintEscrow)
        .pay.ToAddress(beneficiaryAddress, payoutAssets);
      const withRemainder =
        Object.keys(funderRemainder).length > 0
          ? burnTx.pay.ToAddress(funderAddress, funderRemainder)
          : burnTx;
      return {
        tx: withRemainder,
        isFinal,
        indices: {
          continuation_index: 99n,
          payout_index: 0n,
          funder_index: 1n,
        },
      };
    }

    const continuationAssets: Assets = { ...escrowUtxo.assets };
    continuationAssets[assetUnit] =
      (continuationAssets[assetUnit] ?? 0n) - tranche;
    const updatedDatum: EscrowDatumV2 = {
      ...datum,
      released_count: datum.released_count + 1n,
    };
    const tx = baseTx.pay
      .ToContract(
        escrowUtxo.address,
        { kind: "inline", value: Data.to(updatedDatum, EscrowDatumV2) },
        continuationAssets,
      )
      .pay.ToAddress(beneficiaryAddress, payoutAssets);
    return {
      tx,
      isFinal,
      indices: { continuation_index: 0n, payout_index: 1n, funder_index: 99n },
    };
  });

export const stateUnitOf = (stateTokenName: string): string =>
  escrowV2PolicyId + stateTokenName;
