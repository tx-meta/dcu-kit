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
import { SavingsDatum, SavingsSpendRedeemer } from "../types.js";
import { savingsVaultValidator } from "../validators.js";
import { resolveLoan } from "../utils.js";

/**
 * Creates an unsigned transaction advancing an overdue loan one status
 * step: Current -> Late past `due`, Late -> Defaulted past `due + grace`.
 * Permissionless — anyone may crank; the transaction validity's lower bound
 * proves the deadline passed. Only the status changes.
 *
 * @param lucid - Lucid instance with any funded wallet selected.
 * @param config - MarkArrearsConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type MarkArrearsConfig = {
  /** Deployed savings script reference — pass on live networks;
   *  the ~15.5KB validator cannot ride inline within the tx limit. */
  scriptRef?: UTxO;
  loanTokenName: string;
  /** Override the wall clock (emulator tests pass emulator.now()). */
  currentTime?: bigint;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

export const unsignedMarkArrearsTxProgram = (
  lucid: LucidEvolution,
  config: MarkArrearsConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: loanUtxo, loan } = yield* resolveLoan(
      lucid,
      config.loanTokenName,
    );

    const network = lucid.config().network ?? "Preprod";
    const now = config.currentTime ?? BigInt(Date.now());
    // The ledger carries validFrom as a 1-second SLOT and floors it, while the
    // deadline checks below compare milliseconds. Without rounding up, a bound
    // a few hundred ms past `due` passes these checks and then floors to a slot
    // at or before `due`, so the validator rejects a transaction the SDK just
    // said was fine. Round to the next whole second so both agree.
    const drift = now - (network === "Custom" ? 0n : 60_000n);
    const validFrom = ((drift + 999n) / 1000n) * 1000n;

    let nextStatus: "Late" | "Defaulted";
    if (loan.status === "Current") {
      if (validFrom <= loan.due) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "loanTokenName",
            message: `the loan is not yet due (due ${loan.due})`,
          }),
        );
      }
      nextStatus = "Late";
    } else if (loan.status === "Late") {
      if (validFrom <= loan.due + loan.grace) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "loanTokenName",
            message: `the grace period runs until ${loan.due + loan.grace}`,
          }),
        );
      }
      nextStatus = "Defaulted";
    } else {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "loanTokenName",
          message: "the loan is already Defaulted",
        }),
      );
    }

    const newLoan = { ...loan, status: nextStatus };
    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            MarkArrears: {
              loan_input_index: inputIndices[0],
              loan_output_index: 0n,
            },
          },
          SavingsSpendRedeemer,
        ),
      inputs: [loanUtxo],
    };

    return yield* (yield* attachTxMessage(lucid.newTx(), config.message))
      .collectFrom([loanUtxo], redeemer)
      .compose(
        config.scriptRef
          ? lucid.newTx().readFrom([config.scriptRef])
          : lucid
              .newTx()
              .attach.SpendingValidator(savingsVaultValidator.spendVault),
      )
      .pay.ToContract(
        loanUtxo.address,
        {
          kind: "inline",
          value: Data.to({ LoanAccount: newLoan }, SavingsDatum),
        },
        loanUtxo.assets,
      )
      .validFrom(Number(validFrom))
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "markArrears",
              error: String(e),
            }),
        ),
      );
  });

export const markArrears = (lucid: LucidEvolution, config: MarkArrearsConfig) =>
  makeReturn(unsignedMarkArrearsTxProgram(lucid, config));
