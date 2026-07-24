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
import {
  SavingsDatum,
  SavingsMintRedeemer,
  SavingsSpendRedeemer,
} from "../types.js";
import { savingsPolicyId, savingsVaultValidator } from "../validators.js";
import {
  findUserTokenUtxo,
  fundAssetUnit,
  resolveFund,
  resolveLoan,
  resolveMemberAccount,
  withAssetDelta,
} from "../utils.js";

/**
 * Creates an unsigned transaction repaying a loan. Omit `principal` and
 * `charge` to CLOSE the loan (full outstanding + remaining charge; the Loan
 * State NFT burns and the record's min-ADA returns to the borrower);
 * provide them for a partial repayment. The charge portion is income and
 * flows to the next share-out pot. A Late or Defaulted borrower can always
 * still repay.
 *
 * @param lucid - Lucid instance with the borrower's wallet selected.
 * @param config - RepayLoanConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type RepayLoanConfig = {
  /** Deployed savings script reference — pass on live networks;
   *  the ~15.5KB validator cannot ride inline within the tx limit. */
  scriptRef?: UTxO;
  fundTokenName: string;
  memberTokenSuffix: string;
  loanTokenName: string;
  /** Partial: principal portion (base units). Omit both to close. */
  principal?: bigint;
  /** Partial: charge portion (base units). Omit both to close. */
  charge?: bigint;
};

export const unsignedRepayLoanTxProgram = (
  lucid: LucidEvolution,
  config: RepayLoanConfig,
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
    const { utxo: loanUtxo, loan } = yield* resolveLoan(
      lucid,
      config.loanTokenName,
    );
    const userTokenUtxo = yield* findUserTokenUtxo(lucid, userUnit);

    const closing =
      config.principal === undefined && config.charge === undefined;
    const principalPaid = closing ? loan.outstanding : (config.principal ?? 0n);
    const chargeInc = closing
      ? loan.service_charge - loan.charge_paid
      : (config.charge ?? 0n);
    const amount = principalPaid + chargeInc;

    if (principalPaid < 0n || chargeInc < 0n || amount <= 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "principal",
          message: "the repayment must be positive",
        }),
      );
    }
    if (principalPaid > loan.outstanding) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "principal",
          message: `principal portion must not exceed the outstanding ${loan.outstanding}`,
        }),
      );
    }
    if (loan.charge_paid + chargeInc > loan.service_charge) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "charge",
          message: "the charge portion would overpay the service charge",
        }),
      );
    }
    if (
      !closing &&
      principalPaid === loan.outstanding &&
      loan.charge_paid + chargeInc === loan.service_charge
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "principal",
          message:
            "this repayment settles the loan — omit principal and charge to close it",
        }),
      );
    }

    const unit = fundAssetUnit(fund);
    const newFund = {
      ...fund,
      loans_outstanding: fund.loans_outstanding - principalPaid,
    };
    const newAccount = {
      ...account,
      borrowed: account.borrowed - principalPaid,
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            RepayLoan: {
              fund_input_index: inputIndices[0],
              member_input_index: inputIndices[1],
              loan_input_index: inputIndices[2],
              fund_output_index: 0n,
              member_output_index: 1n,
              loan_output_index: closing ? 99n : 2n,
            },
          },
          SavingsSpendRedeemer,
        ),
      inputs: [fundUtxo, refUtxo, loanUtxo],
    };

    const vaultAddress = fundUtxo.address;
    let tx = lucid
      .newTx()
      .collectFrom([fundUtxo, refUtxo, loanUtxo], redeemer)
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
        withAssetDelta(fundUtxo.assets, unit, amount),
      )
      .pay.ToContract(
        vaultAddress,
        {
          kind: "inline",
          value: Data.to({ MemberAccount: newAccount }, SavingsDatum),
        },
        refUtxo.assets,
      );

    if (closing) {
      tx = tx
        .mintAssets(
          { [savingsPolicyId + config.loanTokenName]: -1n },
          Data.to("BurnLoan", SavingsMintRedeemer),
        )
        .compose(
          config.scriptRef
            ? null
            : lucid
                .newTx()
                .attach.MintingPolicy(savingsVaultValidator.mintVault),
        );
    } else {
      const newLoan = {
        ...loan,
        outstanding: loan.outstanding - principalPaid,
        charge_paid: loan.charge_paid + chargeInc,
      };
      tx = tx.pay.ToContract(
        vaultAddress,
        {
          kind: "inline",
          value: Data.to({ LoanAccount: newLoan }, SavingsDatum),
        },
        loanUtxo.assets,
      );
    }

    return yield* tx.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "repayLoan",
            error: String(e),
          }),
      ),
    );
  });

export const repayLoan = (lucid: LucidEvolution, config: RepayLoanConfig) =>
  makeReturn(unsignedRepayLoanTxProgram(lucid, config));
