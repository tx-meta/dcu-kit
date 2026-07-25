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
import {
  makeReturn,
  attachTxMessage,
  type TxMessage,
} from "../../core/utils/index.js";
import { SavingsMintRedeemer, SavingsSpendRedeemer } from "../types.js";
import { savingsVaultValidator } from "../validators.js";
import {
  findUserTokenUtxo,
  memberUnits,
  resolveMemberAccount,
} from "../utils.js";

/**
 * Creates an unsigned transaction exiting the fund: spends the member's
 * reference UTxO (RemoveAccount) and burns both tokens of the CIP-68 pair
 * (BurnAccount). Requires a zeroed share balance — claim or withdraw first.
 * Works with or without a live fund anchor, so accounts are never stuck
 * after fund closure. The reference UTxO's min-ADA returns to the member.
 *
 * @param lucid - Lucid instance with the member's wallet selected.
 * @param config - ExitFundConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ExitFundConfig = {
  /** Deployed savings script reference — pass on live networks;
   *  the ~15.5KB validator cannot ride inline within the tx limit. */
  scriptRef?: UTxO;
  memberTokenSuffix: string;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

export const unsignedExitFundTxProgram = (
  lucid: LucidEvolution,
  config: ExitFundConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { refUtxo, account, userUnit } = yield* resolveMemberAccount(
      lucid,
      config.memberTokenSuffix,
    );
    const userTokenUtxo = yield* findUserTokenUtxo(lucid, userUnit);
    if (account.share_units !== 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "memberTokenSuffix",
          message: `the account still holds ${account.share_units} share units — claim or withdraw before exiting`,
        }),
      );
    }

    const { refUnit } = memberUnits(config.memberTokenSuffix);

    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { RemoveAccount: { member_input_index: inputIndices[0] } },
          SavingsSpendRedeemer,
        ),
      inputs: [refUtxo],
    };

    return yield* (yield* attachTxMessage(lucid.newTx(), config.message))
      .collectFrom([refUtxo], spendRedeemer)
      .collectFrom([userTokenUtxo])
      .compose(
        config.scriptRef
          ? lucid.newTx().readFrom([config.scriptRef])
          : lucid
              .newTx()
              .attach.SpendingValidator(savingsVaultValidator.spendVault),
      )
      .mintAssets(
        { [refUnit]: -1n, [userUnit]: -1n },
        Data.to("BurnAccount", SavingsMintRedeemer),
      )
      .compose(
        config.scriptRef
          ? null
          : lucid.newTx().attach.MintingPolicy(savingsVaultValidator.mintVault),
      )
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "exitFund",
              error: String(e),
            }),
        ),
      );
  });

export const exitFund = (lucid: LucidEvolution, config: ExitFundConfig) =>
  makeReturn(unsignedExitFundTxProgram(lucid, config));
