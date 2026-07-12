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
import { assetNameLabels, makeReturn } from "../../core/utils/index.js";
import {
  SavingsDatum,
  SavingsMintRedeemer,
  SavingsSpendRedeemer,
} from "../types.js";
import { savingsPolicyId, savingsVaultValidator } from "../validators.js";
import {
  applyQuorumWitness,
  findUserTokenUtxo,
  fundAssetUnit,
  fundStateTokenName,
  MIN_ADA_BUFFER,
  PartyWitness,
  resolveFund,
  resolveMemberAccount,
  withAssetDelta,
} from "../utils.js";

/**
 * Creates an unsigned transaction disbursing a loan: principal from the
 * vault to the borrower's wallet, a loan record UTxO (terms + Loan State
 * NFT) to the vault. Requires BOTH the quorum's signature and the
 * borrower's — build from the borrower's wallet (their user token is
 * consumed), then collect the quorum's partial signature.
 *
 * Eligibility is capped at `max_loan_multiple` times the borrower's share
 * value; one active loan per member; the vault never lends the social fund
 * or the protocol buffer.
 *
 * @param lucid - Lucid instance with the BORROWER's wallet selected.
 * @param config - DisburseLoanConfig.
 * @returns Effect yielding `{ tx, loanTokenName }` — persist the name.
 */
export type DisburseLoanConfig = {
  /** Deployed savings script reference — pass on live networks;
   *  the ~15.5KB validator cannot ride inline within the tx limit. */
  scriptRef?: UTxO;
  fundTokenName: string;
  /** The borrower's member token suffix. */
  memberTokenSuffix: string;
  /** Principal, in base units of the fund asset. */
  principal: bigint;
  /** Flat service charge due at/before closure (fixed, never compounds). */
  serviceCharge: bigint;
  /** Repayment deadline, POSIX ms (must lie beyond the tx validity). */
  due: bigint;
  /** Required when the quorum is a script credential. */
  quorumWitness?: PartyWitness;
  /** Override the wall clock (emulator tests pass emulator.now()). */
  currentTime?: bigint;
};

export const unsignedDisburseLoanTxProgram = (
  lucid: LucidEvolution,
  config: DisburseLoanConfig,
): Effect.Effect<
  { tx: TxSignBuilder; loanTokenName: string },
  DcuError,
  never
> =>
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

    if (fund.status !== "Active") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message: "loans originate only while the fund is Active",
        }),
      );
    }
    if (fund.max_loan_multiple <= 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message: "this fund's charter disables lending (max_loan_multiple 0)",
        }),
      );
    }
    if (account.borrowed !== 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "memberTokenSuffix",
          message: "one active loan per member — repay the current loan first",
        }),
      );
    }
    const cap = fund.max_loan_multiple * account.share_units * fund.share_value;
    if (config.principal <= 0n || config.principal > cap) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "principal",
          message: `principal must be within (0, ${cap}] (max_loan_multiple x share value)`,
        }),
      );
    }
    const unit = fundAssetUnit(fund);
    const buffer = unit === "lovelace" ? MIN_ADA_BUFFER : 0n;
    const vaultAfter = (fundUtxo.assets[unit] ?? 0n) - config.principal;
    if (vaultAfter < fund.social_total + buffer) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "principal",
          message:
            "liquidity guard: the loan would draw the social fund or the protocol buffer",
        }),
      );
    }

    // The loan record's seed is the borrower's user-token UTxO — it is
    // always consumed by this transaction, so its outref names the loan NFT.
    const seed = userTokenUtxo;
    const loanTokenName = yield* fundStateTokenName(seed);
    const loanUnit = savingsPolicyId + loanTokenName;

    const network = lucid.config().network ?? "Preprod";
    const now = config.currentTime ?? BigInt(Date.now());
    const validFrom = Number(now - (network === "Custom" ? 0n : 60_000n));
    const validTo = now + 900_000n;
    if (config.due <= validTo) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "due",
          message:
            "the due date must lie beyond the transaction validity window",
        }),
      );
    }

    const newFund = {
      ...fund,
      loans_outstanding: fund.loans_outstanding + config.principal,
    };
    const newAccount = { ...account, borrowed: config.principal };
    const loanDatum: SavingsDatum = {
      LoanAccount: {
        fund_id: config.fundTokenName,
        // the member (100) reference-token name
        borrower_ref: assetNameLabels.prefix100 + config.memberTokenSuffix,
        principal: config.principal,
        outstanding: config.principal,
        service_charge: config.serviceCharge,
        charge_paid: 0n,
        due: config.due,
        grace: fund.loan_grace,
        status: "Current",
      },
    };

    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            DisburseLoan: {
              fund_input_index: inputIndices[0],
              member_input_index: inputIndices[1],
              seed_input_index: inputIndices[2],
              fund_output_index: 0n,
              member_output_index: 1n,
              loan_output_index: 2n,
            },
          },
          SavingsSpendRedeemer,
        ),
      inputs: [fundUtxo, refUtxo, seed],
    };
    const mintRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { MintLoan: { seed_input_index: inputIndices[0] } },
          SavingsMintRedeemer,
        ),
      inputs: [seed],
    };

    const vaultAddress = fundUtxo.address;
    const txDraft = lucid
      .newTx()
      .collectFrom([fundUtxo, refUtxo], spendRedeemer)
      .collectFrom([userTokenUtxo])
      .compose(
        config.scriptRef
          ? lucid.newTx().readFrom([config.scriptRef])
          : lucid
              .newTx()
              .attach.SpendingValidator(savingsVaultValidator.spendVault),
      )
      .mintAssets({ [loanUnit]: 1n }, mintRedeemer)
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
        withAssetDelta(fundUtxo.assets, unit, -config.principal),
      )
      .pay.ToContract(
        vaultAddress,
        {
          kind: "inline",
          value: Data.to({ MemberAccount: newAccount }, SavingsDatum),
        },
        refUtxo.assets,
      )
      .pay.ToContract(
        vaultAddress,
        { kind: "inline", value: Data.to(loanDatum, SavingsDatum) },
        { lovelace: MIN_ADA_BUFFER, [loanUnit]: 1n },
      )
      .validFrom(validFrom)
      .validTo(Number(validTo));

    const txWitnessed = yield* applyQuorumWitness(
      lucid,
      txDraft,
      fund.quorum,
      config.quorumWitness,
    );

    const tx = yield* txWitnessed.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "disburseLoan",
            error: String(e),
          }),
      ),
    );

    return { tx, loanTokenName };
  });

export const disburseLoan = (
  lucid: LucidEvolution,
  config: DisburseLoanConfig,
) => makeReturn(unsignedDisburseLoanTxProgram(lucid, config));
