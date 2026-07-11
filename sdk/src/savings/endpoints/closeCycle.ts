import {
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
import { SavingsDatum, SavingsSpendRedeemer } from "../types.js";
import { savingsVaultValidator } from "../validators.js";
import {
  applyQuorumWitness,
  fundAssetUnit,
  MIN_ADA_BUFFER,
  PartyWitness,
  resolveFund,
  savingsVaultAddress,
} from "../utils.js";

/**
 * Creates an unsigned transaction freezing the share-out snapshot: everything
 * in the vault except the social fund (and, for ADA funds, the anchor's
 * protocol min-ADA buffer) becomes the distributable pot at the share ratio
 * standing at close. Freezing moves no value.
 *
 * @param lucid - Lucid instance with a quorum-side wallet selected.
 * @param config - CloseCycleConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type CloseCycleConfig = {
  fundTokenName: string;
  /** Required when the quorum is a script credential. */
  quorumWitness?: PartyWitness;
};

export const unsignedCloseCycleTxProgram = (
  lucid: LucidEvolution,
  config: CloseCycleConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: fundUtxo, fund } = yield* resolveFund(
      lucid,
      config.fundTokenName,
    );
    if (fund.status !== "Active") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message: "the cycle is already closed",
        }),
      );
    }

    const network = lucid.config().network ?? "Preprod";
    const now = BigInt(Date.now());
    if (
      fund.cycle_end !== null &&
      network !== "Custom" &&
      now < fund.cycle_end
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message: `the cycle runs until ${fund.cycle_end} (POSIX ms)`,
        }),
      );
    }

    const unit = fundAssetUnit(fund);
    // The anchor's protocol buffer is not a deposit: for ADA funds it is
    // excluded from the pot so the last claims never break on min-ADA.
    const buffer = unit === "lovelace" ? MIN_ADA_BUFFER : 0n;
    const vaultValue = fundUtxo.assets[unit] ?? 0n;
    const pot = vaultValue - fund.social_total - buffer;
    if (pot <= 0n || fund.shares_total <= 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message: "nothing to share out — the fund has no distributable pot",
        }),
      );
    }

    const newFund = {
      ...fund,
      shares_total: 0n,
      savings_total: 0n,
      status: {
        SharingOut: {
          pot,
          shares: fund.shares_total,
          shares_remaining: fund.shares_total,
        },
      },
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            CloseCycle: {
              fund_input_index: inputIndices[0],
              fund_output_index: 0n,
            },
          },
          SavingsSpendRedeemer,
        ),
      inputs: [fundUtxo],
    };

    const validFrom = Number(now - (network === "Custom" ? 0n : 60_000n));
    const txDraft = lucid
      .newTx()
      .collectFrom([fundUtxo], redeemer)
      .attach.SpendingValidator(savingsVaultValidator.spendVault)
      .pay.ToContract(
        savingsVaultAddress(network),
        {
          kind: "inline",
          value: Data.to({ SavingsFund: newFund }, SavingsDatum),
        },
        fundUtxo.assets,
      )
      .validFrom(validFrom);

    const txWitnessed = yield* applyQuorumWitness(
      lucid,
      txDraft,
      fund.quorum,
      config.quorumWitness,
    );

    return yield* txWitnessed.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "closeCycle",
            error: String(e),
          }),
      ),
    );
  });

export const closeCycle = (lucid: LucidEvolution, config: CloseCycleConfig) =>
  makeReturn(unsignedCloseCycleTxProgram(lucid, config));
