import {
  Data,
  fromText,
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
import {
  PartyRef,
  partyToCredential,
  SavingsDatum,
  SavingsSpendRedeemer,
} from "../types.js";
import { savingsVaultValidator } from "../validators.js";
import {
  applyQuorumWitness,
  PartyWitness,
  resolveFund,
  savingsVaultAddress,
} from "../utils.js";

/**
 * Creates an unsigned transaction amending the charter's mutable fields
 * (title, purchase band, withdrawal policy, cycle end) or rotating the
 * quorum credential, under quorum authorization. The asset, share value,
 * totals, and status are immutable through this path.
 *
 * @param lucid - Lucid instance with a quorum-side wallet selected.
 * @param config - UpdateFundConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type UpdateFundConfig = {
  fundTokenName: string;
  title?: string;
  /** Rotate the ratification authority. */
  quorum?: PartyRef;
  minSharesPerDeposit?: bigint;
  maxSharesPerDeposit?: bigint;
  withdrawalPolicy?: bigint;
  /** Pass null to clear the bound. */
  cycleEnd?: bigint | null;
  /** Required when the CURRENT quorum is a script credential. */
  quorumWitness?: PartyWitness;
};

export const unsignedUpdateFundTxProgram = (
  lucid: LucidEvolution,
  config: UpdateFundConfig,
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
          message: "charter updates are only valid while the fund is Active",
        }),
      );
    }

    const titleHex =
      config.title !== undefined ? fromText(config.title) : fund.title;
    if (titleHex.length > 128) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "title",
          message: "title must be at most 64 UTF-8 bytes",
        }),
      );
    }
    const newQuorum =
      config.quorum !== undefined
        ? yield* partyToCredential(config.quorum, "quorum")
        : fund.quorum;
    const minShares = config.minSharesPerDeposit ?? fund.min_shares_per_deposit;
    const maxShares = config.maxSharesPerDeposit ?? fund.max_shares_per_deposit;
    const withdrawalPolicy = config.withdrawalPolicy ?? fund.withdrawal_policy;
    if (minShares <= 0n || minShares > maxShares) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "minSharesPerDeposit",
          message: "purchase band must satisfy 0 < min <= max",
        }),
      );
    }
    if (withdrawalPolicy !== 0n && withdrawalPolicy !== 1n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "withdrawalPolicy",
          message: "withdrawalPolicy must be 0 (locked) or 1 (flexible)",
        }),
      );
    }

    const newFund = {
      ...fund,
      title: titleHex,
      quorum: newQuorum,
      min_shares_per_deposit: minShares,
      max_shares_per_deposit: maxShares,
      withdrawal_policy: withdrawalPolicy,
      cycle_end:
        config.cycleEnd === undefined ? fund.cycle_end : config.cycleEnd,
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            UpdateFund: {
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
        fundUtxo.assets,
      );

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
            operation: "updateFund",
            error: String(e),
          }),
      ),
    );
  });

export const updateFund = (lucid: LucidEvolution, config: UpdateFundConfig) =>
  makeReturn(unsignedUpdateFundTxProgram(lucid, config));
