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
  InsufficientUtxosError,
  TransactionBuildError,
} from "../../core/errors.js";
import {
  assetNameLabels,
  getWalletUtxos,
  makeReturn,
  sortUtxos,
  attachTxMessage,
  type TxMessage,
} from "../../core/utils/index.js";
import {
  SavingsDatum,
  SavingsMintRedeemer,
  SavingsGovernedAction,
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
  resolveLoan,
  resolveMemberAccount,
} from "../utils.js";

/**
 * Creates an unsigned transaction writing off a Defaulted loan under quorum
 * authorization: the borrower's shares are seized up to the outstanding
 * amount (rounding against the defaulter, bounded by one share); the
 * remainder is socialized (it shrinks the future pot). No value moves out
 * of the vault — this is accounting plus the record's burn, and the
 * permanent Defaulted history is the standing signal.
 *
 * @param lucid - Lucid instance with a quorum-side wallet selected.
 * @param config - WriteOffLoanConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type WriteOffLoanConfig = SavingsRefConfig & {
  fundTokenName: string;
  loanTokenName: string;
  /** Required when the quorum is a script credential. */
  quorumWitness?: PartyWitness;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

export const unsignedWriteOffLoanTxProgram = (
  lucid: LucidEvolution,
  config: WriteOffLoanConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: fundUtxo, fund } = yield* resolveFund(
      lucid,
      config.fundTokenName,
    );
    const { utxo: loanUtxo, loan } = yield* resolveLoan(
      lucid,
      config.loanTokenName,
    );
    if (loan.status !== "Defaulted") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "loanTokenName",
          message:
            "only Defaulted loans can be written off — crank markArrears first",
        }),
      );
    }
    const memberTokenSuffix = loan.borrower_ref.slice(
      assetNameLabels.prefix100.length,
    );
    const { refUtxo, account } = yield* resolveMemberAccount(
      lucid,
      memberTokenSuffix,
    );

    // Share seizure mirrors the on-chain rule exactly.
    const needed =
      (loan.outstanding + fund.share_value - 1n) / fund.share_value;
    const seizedUnits =
      needed < account.share_units ? needed : account.share_units;
    const seizedValue = seizedUnits * fund.share_value;

    const newFund = {
      ...fund,
      shares_total: fund.shares_total - seizedUnits,
      savings_total: fund.savings_total - seizedValue,
      loans_outstanding: fund.loans_outstanding - loan.outstanding,
    };
    const newAccount = {
      ...account,
      share_units: account.share_units - seizedUnits,
      borrowed: 0n,
    };
    const intentHash = computeSavingsIntentHash({
      WriteOffLoanIntent: { loan_id: config.loanTokenName },
    });

    // ADR-0003: the spending redeemer carries the operation and its ADR-0002
    // commitment at field 0 — the bytes the Governance Gate reads. Indices and
    // the covered set ride on the governed family withdrawal.
    const spendRedeemer = Data.to(
      { WriteOffLoan: { intent_hash: intentHash } },
      SavingsSpendRedeemer,
    );
    const action: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            WriteOffLoanAction: {
              covered_inputs: [
                inputIndices[0],
                inputIndices[1],
                inputIndices[2],
              ],
              fund_input_index: inputIndices[0],
              member_input_index: inputIndices[1],
              loan_input_index: inputIndices[2],
              fund_output_index: 0n,
              member_output_index: 1n,
            },
          },
          SavingsGovernedAction,
        ),
      inputs: [fundUtxo, refUtxo, loanUtxo],
    };

    // An explicit fee input keeps coin selection stable AFTER the redeemer
    // indices are built (Lucid re-selection would shift them).
    const feeInput = sortUtxos(yield* getWalletUtxos(lucid)).filter(
      (u) => !u.scriptRef,
    )[0];
    if (!feeInput) {
      return yield* Effect.fail(
        new InsufficientUtxosError({ required: 1, available: 0 }),
      );
    }

    const vaultAddress = fundUtxo.address;
    const network = lucid.config().network ?? "Preprod";
    const txDraft = (yield* attachTxMessage(lucid.newTx(), config.message))
      .collectFrom([fundUtxo, refUtxo, loanUtxo], spendRedeemer)
      .collectFrom([feeInput])
      .compose(
        config.scriptRef
          ? lucid.newTx().readFrom([config.scriptRef])
          : lucid
              .newTx()
              .attach.SpendingValidator(savingsVaultValidator.spendVault),
      )
      .mintAssets(
        { [savingsPolicyId + config.loanTokenName]: -1n },
        Data.to("BurnLoan", SavingsMintRedeemer),
      )
      .compose(
        config.scriptRef
          ? null
          : lucid.newTx().attach.MintingPolicy(savingsVaultValidator.mintVault),
      )
      .pay.ToContract(
        vaultAddress,
        {
          kind: "inline",
          value: Data.to({ SavingsFund: newFund }, SavingsDatum),
        },
        fundUtxo.assets,
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
            operation: "writeOffLoan",
            error: String(e),
          }),
      ),
    );
  });

export const writeOffLoan = (
  lucid: LucidEvolution,
  config: WriteOffLoanConfig,
) => makeReturn(unsignedWriteOffLoanTxProgram(lucid, config));
