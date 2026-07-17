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
  InsufficientUtxosError,
  TransactionBuildError,
} from "../../core/errors.js";
import {
  assetNameLabels,
  getWalletUtxos,
  makeReturn,
  sortUtxos,
} from "../../core/utils/index.js";
import {
  SavingsDatum,
  SavingsMintRedeemer,
  SavingsSpendRedeemer,
} from "../types.js";
import { savingsPolicyId, savingsVaultValidator } from "../validators.js";
import {
  applyQuorumWitness,
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
export type WriteOffLoanConfig = {
  /** Deployed savings script reference — pass on live networks;
   *  the ~15.5KB validator cannot ride inline within the tx limit. */
  scriptRef?: UTxO;
  fundTokenName: string;
  loanTokenName: string;
  /** Required when the quorum is a script credential. */
  quorumWitness?: PartyWitness;
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

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            WriteOffLoan: {
              fund_input_index: inputIndices[0],
              member_input_index: inputIndices[1],
              loan_input_index: inputIndices[2],
              fund_output_index: 0n,
              member_output_index: 1n,
            },
          },
          SavingsSpendRedeemer,
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
    const txDraft = lucid
      .newTx()
      .collectFrom([fundUtxo, refUtxo, loanUtxo], redeemer)
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
