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
  getWalletAddress,
  makeReturn,
  attachTxMessage,
  type TxMessage,
} from "../../core/utils/index.js";
import {
  SavingsGovernedAction,
  SavingsMintRedeemer,
  SavingsSpendRedeemer,
} from "../types.js";
import {
  attachSavingsFamilyWithdrawal,
  type SavingsRefConfig,
} from "../familyWithdraw.js";
import { savingsPolicyId, savingsVaultValidator } from "../validators.js";
import {
  applyQuorumWitness,
  computeSavingsIntentHash,
  PartyWitness,
  resolveFund,
  toSavingsAddress,
} from "../utils.js";

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
export type CloseFundConfig = SavingsRefConfig & {
  fundTokenName: string;
  /** Residual destination. Defaults to the connected wallet. */
  destination?: string;
  /** Required when the quorum is a script credential. */
  quorumWitness?: PartyWitness;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
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
    const intentHash = computeSavingsIntentHash({
      CloseFundIntent: { destination: toSavingsAddress(destination) },
    });

    // ADR-0003: the spending redeemer carries the operation and its ADR-0002
    // commitment at field 0 — the bytes the Governance Gate reads. Indices and
    // the covered set ride on the governed family withdrawal.
    const spendRedeemer = Data.to(
      { CloseFund: { intent_hash: intentHash } },
      SavingsSpendRedeemer,
    );
    const action: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            CloseFundAction: {
              covered_inputs: [inputIndices[0]],
              fund_input_index: inputIndices[0],
              payout_output_index: 0n,
            },
          },
          SavingsGovernedAction,
        ),
      inputs: [fundUtxo],
    };

    const network = lucid.config().network ?? "Preprod";
    const txDraft = (yield* attachTxMessage(lucid.newTx(), config.message))
      .collectFrom([fundUtxo], spendRedeemer)
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

    const txWithFamily = attachSavingsFamilyWithdrawal(
      txDraft,
      network,
      "governed",
      action,
      config.familyRef,
    );

    const txWitnessed = yield* applyQuorumWitness(
      lucid,
      txWithFamily,
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
