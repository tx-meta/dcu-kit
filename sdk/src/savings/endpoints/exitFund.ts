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
  SavingsDirectAction,
  SavingsMintRedeemer,
  SavingsSpendRedeemer,
} from "../types.js";
import {
  attachSavingsFamilyWithdrawal,
  type SavingsRefConfig,
} from "../familyWithdraw.js";
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
export type ExitFundConfig = SavingsRefConfig & {
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

    // ADR-0003: the spending redeemer carries only the operation; indices and
    // the covered set ride on the direct family withdrawal, which runs the
    // validation once per transaction.
    const spendRedeemer = Data.to("RemoveAccount", SavingsSpendRedeemer);
    const action: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            RemoveAccountAction: {
              covered_inputs: [inputIndices[0]],
              member_input_index: inputIndices[0],
            },
          },
          SavingsDirectAction,
        ),
      inputs: [refUtxo],
    };

    const network = lucid.config().network ?? "Preprod";
    const baseTx = (yield* attachTxMessage(lucid.newTx(), config.message))
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
            operation: "exitFund",
            error: String(e),
          }),
      ),
    );
  });

export const exitFund = (lucid: LucidEvolution, config: ExitFundConfig) =>
  makeReturn(unsignedExitFundTxProgram(lucid, config));
