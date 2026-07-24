import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  TransactionBuildError,
} from "../../core/errors.js";
import { makeReturn } from "../../core/utils/index.js";
import {
  FUND_TAG_SAVINGS,
  FUND_TAG_SOCIAL,
  FUND_TAG_TOPUP,
  SavingsDatum,
  SavingsSpendRedeemer,
} from "../types.js";
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
 * Creates an unsigned transaction paying into the fund. Tag 0 buys share
 * units (`units` required), tag 1 contributes to the social fund, tag 2 is
 * an untagged top-up (penalties, donations) with no datum change.
 *
 * @param lucid - Lucid instance with the member's wallet selected.
 * @param config - DepositConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type DepositConfig = {
  /** Deployed savings script reference — pass on live networks;
   *  the ~15.5KB validator cannot ride inline within the tx limit. */
  scriptRef?: UTxO;
  fundTokenName: string;
  memberTokenSuffix: string;
  /** 0n = buy shares (default), 1n = social fund, 2n = top-up. */
  fundTag?: bigint;
  /** Tag 0: number of share units to buy. */
  units?: bigint;
  /** Tags 1 and 2: amount in base units of the fund asset. */
  amount?: bigint;
};

export const unsignedDepositTxProgram = (
  lucid: LucidEvolution,
  config: DepositConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const fundTag = config.fundTag ?? FUND_TAG_SAVINGS;
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
          message: "deposits are only valid while the fund is Active",
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

    let delta: bigint;
    let newFund = { ...fund };
    let newAccount = { ...account };
    if (fundTag === FUND_TAG_SAVINGS) {
      const units = config.units ?? 0n;
      if (
        units < fund.min_shares_per_deposit ||
        units > fund.max_shares_per_deposit
      ) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "units",
            message: `share purchase must be within the fund's band [${fund.min_shares_per_deposit}, ${fund.max_shares_per_deposit}]`,
          }),
        );
      }
      delta = units * fund.share_value;
      newFund = {
        ...fund,
        shares_total: fund.shares_total + units,
        savings_total: fund.savings_total + delta,
      };
      newAccount = { ...account, share_units: account.share_units + units };
    } else if (fundTag === FUND_TAG_SOCIAL) {
      delta = config.amount ?? 0n;
      newFund = { ...fund, social_total: fund.social_total + delta };
      newAccount = { ...account, social_paid: account.social_paid + delta };
    } else if (fundTag === FUND_TAG_TOPUP) {
      delta = config.amount ?? 0n;
    } else {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTag",
          message: "fundTag must be 0 (shares), 1 (social), or 2 (top-up)",
        }),
      );
    }
    if (delta <= 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: fundTag === FUND_TAG_SAVINGS ? "units" : "amount",
          message: "the deposit must be positive",
        }),
      );
    }

    const unit = fundAssetUnit(fund);
    const newFundAssets = withAssetDelta(fundUtxo.assets, unit, delta);

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            Deposit: {
              fund_input_index: inputIndices[0],
              member_input_index: inputIndices[1],
              fund_output_index: 0n,
              member_output_index: 1n,
              fund_tag: fundTag,
            },
          },
          SavingsSpendRedeemer,
        ),
      inputs: [fundUtxo, refUtxo],
    };

    const network = lucid.config().network ?? "Preprod";
    const vaultAddress = savingsVaultAddress(network);
    return yield* lucid
      .newTx()
      .collectFrom([fundUtxo, refUtxo], redeemer)
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
      )
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "deposit",
              error: String(e),
            }),
        ),
      );
  });

export const deposit = (lucid: LucidEvolution, config: DepositConfig) =>
  makeReturn(unsignedDepositTxProgram(lucid, config));
