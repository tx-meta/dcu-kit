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
  PartyWitness,
  resolveFund,
  savingsVaultAddress,
  withAssetDelta,
} from "../utils.js";

/**
 * Creates an unsigned transaction paying a welfare claim from the social
 * fund under quorum authorization. Valid while Active AND during share-out —
 * welfare does not stop for cycle close.
 *
 * @param lucid - Lucid instance with a quorum-side wallet selected.
 * @param config - SocialPayoutConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type SocialPayoutConfig = {
  fundTokenName: string;
  /** Payment in base units of the fund asset. */
  amount: bigint;
  /** The beneficiary address (the quorum's decision). */
  destination: string;
  /** Required when the quorum is a script credential. */
  quorumWitness?: PartyWitness;
};

export const unsignedSocialPayoutTxProgram = (
  lucid: LucidEvolution,
  config: SocialPayoutConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: fundUtxo, fund } = yield* resolveFund(
      lucid,
      config.fundTokenName,
    );
    if (config.amount <= 0n || config.amount > fund.social_total) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "amount",
          message: `amount must be within (0, ${fund.social_total}] (the social fund)`,
        }),
      );
    }

    const unit = fundAssetUnit(fund);
    const newFund = {
      ...fund,
      social_total: fund.social_total - config.amount,
    };
    const newFundAssets = withAssetDelta(fundUtxo.assets, unit, -config.amount);

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            SocialPayout: {
              fund_input_index: inputIndices[0],
              fund_output_index: 0n,
            },
          },
          SavingsSpendRedeemer,
        ),
      inputs: [fundUtxo],
    };

    const network = lucid.config().network ?? "Preprod";
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
        newFundAssets,
      )
      .pay.ToAddress(config.destination, { [unit]: config.amount });

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
            operation: "socialPayout",
            error: String(e),
          }),
      ),
    );
  });

export const socialPayout = (
  lucid: LucidEvolution,
  config: SocialPayoutConfig,
) => makeReturn(unsignedSocialPayoutTxProgram(lucid, config));
