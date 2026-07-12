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
import { getWalletAddress, makeReturn } from "../../core/utils/index.js";
import { SavingsMintRedeemer, SavingsSpendRedeemer } from "../types.js";
import { savingsPolicyId, savingsVaultValidator } from "../validators.js";
import { applyQuorumWitness, PartyWitness, resolveFund } from "../utils.js";

/**
 * Creates an unsigned transaction closing the fund after every share has
 * been claimed: burns the Fund State NFT and releases the residual value
 * (floor dust plus any unclaimed social fund) to the destination the quorum
 * authorizes.
 *
 * @param lucid - Lucid instance with a quorum-side wallet selected.
 * @param config - CloseFundConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type CloseFundConfig = {
  /** Deployed savings script reference — pass on live networks;
   *  the ~15.5KB validator cannot ride inline within the tx limit. */
  scriptRef?: UTxO;
  fundTokenName: string;
  /** Residual destination. Defaults to the connected wallet. */
  destination?: string;
  /** Required when the quorum is a script credential. */
  quorumWitness?: PartyWitness;
};

export const unsignedCloseFundTxProgram = (
  lucid: LucidEvolution,
  config: CloseFundConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: fundUtxo, fund } = yield* resolveFund(
      lucid,
      config.fundTokenName,
    );
    if (typeof fund.status === "string" || !("SharingOut" in fund.status)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message: "close the cycle first — the fund is still Active",
        }),
      );
    }
    if (fund.status.SharingOut.shares_remaining !== 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message: `${fund.status.SharingOut.shares_remaining} shares are still unclaimed`,
        }),
      );
    }

    const walletAddress = yield* getWalletAddress(lucid);
    const destination = config.destination ?? walletAddress;
    const fundUnit = savingsPolicyId + config.fundTokenName;
    const residual = { ...fundUtxo.assets };
    delete residual[fundUnit];

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { CloseFund: { fund_input_index: inputIndices[0] } },
          SavingsSpendRedeemer,
        ),
      inputs: [fundUtxo],
    };

    const txDraft = lucid
      .newTx()
      .collectFrom([fundUtxo], redeemer)
      .compose(
        config.scriptRef
          ? lucid.newTx().readFrom([config.scriptRef])
          : lucid
              .newTx()
              .attach.SpendingValidator(savingsVaultValidator.spendVault),
      )
      .mintAssets({ [fundUnit]: -1n }, Data.to("BurnFund", SavingsMintRedeemer))
      .compose(
        config.scriptRef
          ? null
          : lucid.newTx().attach.MintingPolicy(savingsVaultValidator.mintVault),
      )
      .pay.ToAddress(destination, residual);

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
            operation: "closeFund",
            error: String(e),
          }),
      ),
    );
  });

export const closeFund = (lucid: LucidEvolution, config: CloseFundConfig) =>
  makeReturn(unsignedCloseFundTxProgram(lucid, config));
