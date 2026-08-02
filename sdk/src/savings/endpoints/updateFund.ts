import {
  Data,
  fromText,
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
  /** Deployed savings script reference — pass on live networks;
   *  the ~15.5KB validator cannot ride inline within the tx limit. */
  scriptRef?: UTxO;
  fundTokenName: string;
  title?: string;
  /** Rotate the ratification authority. */
  quorum?: PartyRef;
  minSharesPerDeposit?: bigint;
  maxSharesPerDeposit?: bigint;
  /**
   * Bring the cycle end forward, or pass null to clear it. It can NEVER be
   * pushed out or newly imposed: cycle_end gates CloseCycle, so extending it
   * would let the quorum defer every member's share-out indefinitely.
   *
   * `withdrawalPolicy` is deliberately absent — it is frozen for the life of
   * the fund, because it is what a member relied on when they deposited.
   */
  cycleEnd?: bigint | null;
  /** Required when the CURRENT quorum is a script credential. */
  quorumWitness?: PartyWitness;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
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
    if (minShares <= 0n || minShares > maxShares) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "minSharesPerDeposit",
          message: "purchase band must satisfy 0 < min <= max",
        }),
      );
    }
    // Fail fast with the reason, rather than letting the validator reject the
    // built transaction with a bare script-execution error.
    const cycleEnd =
      config.cycleEnd === undefined ? fund.cycle_end : config.cycleEnd;
    if (cycleEnd !== null) {
      if (fund.cycle_end === null) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "cycleEnd",
            message:
              "a cycle end cannot be imposed on a fund that has none — it would defer every share-out",
          }),
        );
      }
      if (cycleEnd > fund.cycle_end) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "cycleEnd",
            message: `the cycle end can only move earlier (current ${fund.cycle_end})`,
          }),
        );
      }
    }

    const newFund = {
      ...fund,
      title: titleHex,
      quorum: newQuorum,
      min_shares_per_deposit: minShares,
      max_shares_per_deposit: maxShares,
      // withdrawal_policy is carried through from `fund` by the spread — the
      // validator freezes it, so there is nothing to set here.
      cycle_end: cycleEnd,
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
    const txDraft = (yield* attachTxMessage(lucid.newTx(), config.message))
      .collectFrom([fundUtxo], redeemer)
      .compose(
        config.scriptRef
          ? lucid.newTx().readFrom([config.scriptRef])
          : lucid
              .newTx()
              .attach.SpendingValidator(savingsVaultValidator.spendVault),
      )
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
