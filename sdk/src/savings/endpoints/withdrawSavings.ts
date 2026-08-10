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
import {
  makeReturn,
  attachTxMessage,
  type TxMessage,
} from "../../core/utils/index.js";
import {
  SavingsDatum,
  SavingsDirectAction,
  SavingsSpendRedeemer,
} from "../types.js";
import {
  attachSavingsFamilyWithdrawal,
  type SavingsRefConfig,
} from "../familyWithdraw.js";
import { savingsVaultValidator } from "../validators.js";
import {
  findUserTokenUtxo,
  fundAssetUnit,
  resolveFund,
  resolveMemberAccount,
  savingsVaultAddress,
  withAssetDelta,
} from "../utils.js";

/**
 * Creates an unsigned transaction selling share units back before cycle
 * close. Only valid when the fund's withdrawal policy is 1 (ASCA flexible);
 * the VSLA preset (0) locks savings until share-out.
 *
 * @param lucid - Lucid instance with the member's wallet selected.
 * @param config - WithdrawSavingsConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type WithdrawSavingsConfig = SavingsRefConfig & {
  fundTokenName: string;
  memberTokenSuffix: string;
  /** Number of share units to sell back. */
  units: bigint;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

export const unsignedWithdrawSavingsTxProgram = (
  lucid: LucidEvolution,
  config: WithdrawSavingsConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: fundUtxo, fund } = yield* resolveFund(
      lucid,
      config.fundTokenName,
    );
    const { refUtxo, account, userUnit } = yield* resolveMemberAccount(
      lucid,
      config.memberTokenSuffix,
    );
    const userTokenUtxo = yield* findUserTokenUtxo(lucid, userUnit);

    if (fund.status !== "Active") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message: "withdrawals are only valid while the fund is Active",
        }),
      );
    }
    if (fund.withdrawal_policy !== 1n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message:
            "this fund locks savings until share-out (withdrawal_policy 0)",
        }),
      );
    }
    if (account.fund_id !== config.fundTokenName) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "memberTokenSuffix",
          message: "this member account belongs to a different fund",
        }),
      );
    }
    if (config.units <= 0n || config.units > account.share_units) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "units",
          message: `units must be within (0, ${account.share_units}]`,
        }),
      );
    }

    const delta = config.units * fund.share_value;
    const unit = fundAssetUnit(fund);
    const newFund = {
      ...fund,
      shares_total: fund.shares_total - config.units,
      savings_total: fund.savings_total - delta,
    };
    const newAccount = {
      ...account,
      share_units: account.share_units - config.units,
    };
    const newFundAssets = withAssetDelta(fundUtxo.assets, unit, -delta);

    // ADR-0003: the spending redeemer carries only the operation; indices and
    // the covered set ride on the direct family withdrawal, which runs the
    // validation once per transaction.
    const spendRedeemer = Data.to("Withdraw", SavingsSpendRedeemer);
    const action: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            WithdrawAction: {
              covered_inputs: [inputIndices[0], inputIndices[1]],
              fund_input_index: inputIndices[0],
              member_input_index: inputIndices[1],
              fund_output_index: 0n,
              member_output_index: 1n,
            },
          },
          SavingsDirectAction,
        ),
      inputs: [fundUtxo, refUtxo],
    };

    const network = lucid.config().network ?? "Preprod";
    const vaultAddress = savingsVaultAddress(network);
    const baseTx = (yield* attachTxMessage(lucid.newTx(), config.message))
      .collectFrom([fundUtxo, refUtxo], spendRedeemer)
      .collectFrom([userTokenUtxo])
      .compose(
        config.scriptRef
          ? lucid.newTx().readFrom([config.scriptRef])
          : lucid
              .newTx()
              .attach.SpendingValidator(savingsVaultValidator.spendVault),
      )
      .pay.ToContract(
        vaultAddress,
        {
          kind: "inline",
          value: Data.to({ SavingsFund: newFund }, SavingsDatum),
        },
        newFundAssets,
      )
      .pay.ToContract(
        vaultAddress,
        {
          kind: "inline",
          value: Data.to({ MemberAccount: newAccount }, SavingsDatum),
        },
        refUtxo.assets,
      );

    const txWithFamily = attachSavingsFamilyWithdrawal(
      baseTx,
      network,
      "direct",
      action,
      config.familyRef,
    );

    return yield* txWithFamily.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "withdrawSavings",
            error: String(e),
          }),
      ),
    );
  });

export const withdrawSavings = (
  lucid: LucidEvolution,
  config: WithdrawSavingsConfig,
) => makeReturn(unsignedWithdrawSavingsTxProgram(lucid, config));
