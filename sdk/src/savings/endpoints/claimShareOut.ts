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
import { SavingsDatum, SavingsSpendRedeemer } from "../types.js";
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
 * Creates an unsigned transaction claiming the member's proportional
 * share-out: `pot * share_units / shares` (floor). Claims are independent
 * per member — any order, any concurrency, no crank, no member ceiling.
 *
 * @param lucid - Lucid instance with the member's wallet selected.
 * @param config - ClaimShareOutConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ClaimShareOutConfig = {
  /** Deployed savings script reference — pass on live networks;
   *  the ~15.5KB validator cannot ride inline within the tx limit. */
  scriptRef?: UTxO;
  fundTokenName: string;
  memberTokenSuffix: string;
};

export const unsignedClaimShareOutTxProgram = (
  lucid: LucidEvolution,
  config: ClaimShareOutConfig,
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

    if (fund.status === "Active" || typeof fund.status === "string") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message: "the cycle is not closed — nothing to claim yet",
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
    if (account.share_units <= 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "memberTokenSuffix",
          message: "this account holds no share units to claim for",
        }),
      );
    }

    const { pot, shares, shares_remaining } = fund.status.SharingOut;
    const paid = (pot * account.share_units) / shares;
    const unit = fundAssetUnit(fund);
    const newFund = {
      ...fund,
      status: {
        SharingOut: {
          pot,
          shares,
          shares_remaining: shares_remaining - account.share_units,
        },
      },
    };
    const newAccount = { ...account, share_units: 0n };
    const newFundAssets = withAssetDelta(fundUtxo.assets, unit, -paid);

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            ClaimShareOut: {
              fund_input_index: inputIndices[0],
              member_input_index: inputIndices[1],
              fund_output_index: 0n,
              member_output_index: 1n,
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
              operation: "claimShareOut",
              error: String(e),
            }),
        ),
      );
  });

export const claimShareOut = (
  lucid: LucidEvolution,
  config: ClaimShareOutConfig,
) => makeReturn(unsignedClaimShareOutTxProgram(lucid, config));
