import { Data, getAddressDetails } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { ConfigurationError } from "../core/errors.js";
import { CredentialSchema } from "../core/types.js";

// --- Fund status ---

export const FundStatusSchema = Data.Enum([
  Data.Literal("Active"),
  Data.Object({
    SharingOut: Data.Object({
      /** The distributable pot frozen at cycle close. */
      pot: Data.Integer(),
      /** shares_total frozen at cycle close — the claim denominator. */
      shares: Data.Integer(),
      /** Counts down to 0 as members claim; 0 unlocks CloseFund. */
      shares_remaining: Data.Integer(),
    }),
  }),
]);
export type FundStatus = Data.Static<typeof FundStatusSchema>;
export const FundStatus = FundStatusSchema as unknown as FundStatus;

export const LoanStatusSchema = Data.Enum([
  Data.Literal("Current"),
  Data.Literal("Late"),
  Data.Literal("Defaulted"),
]);
export type LoanStatus = Data.Static<typeof LoanStatusSchema>;
export const LoanStatus = LoanStatusSchema as unknown as LoanStatus;

// --- Vault datum (three variants at one address) ---

export const SavingsFundFieldsSchema = Data.Object({
  /** Short inline fund name (max 64 bytes). Group-level only, never PII. */
  title: Data.Bytes(),
  /** Ratification authority — a multisig today, a vote script later. */
  quorum: CredentialSchema,
  /** The fund's asset. Empty string (`""`) means ADA. */
  asset_policy: Data.Bytes(),
  asset_name: Data.Bytes(),
  /** Price of one share unit in base units of the asset. Immutable. */
  share_value: Data.Integer(),
  /** VSLA-style per-transaction purchase band. */
  min_shares_per_deposit: Data.Integer(),
  max_shares_per_deposit: Data.Integer(),
  /** 0 = locked until share-out (VSLA), 1 = flexible withdrawal (ASCA). */
  withdrawal_policy: Data.Integer(),
  /** Borrow up to this multiple of own share value; 0 disables lending. */
  max_loan_multiple: Data.Integer(),
  /** Ms after a loan's due before Late can become Defaulted. */
  loan_grace: Data.Integer(),
  /** CloseCycle is invalid before this bound (null = quorum decides). */
  cycle_end: Data.Nullable(Data.Integer()),
  /** Sum of all members' share units — the load-bearing aggregate. */
  shares_total: Data.Integer(),
  /** Always shares_total * share_value. */
  savings_total: Data.Integer(),
  /** The welfare fund; never part of the share-out pot. */
  social_total: Data.Integer(),
  /** Total principal currently lent out (the loan book total). */
  loans_outstanding: Data.Integer(),
  status: FundStatusSchema,
});
export type SavingsFundFields = Data.Static<typeof SavingsFundFieldsSchema>;

export const SavingsDatumSchema = Data.Enum([
  Data.Object({ SavingsFund: SavingsFundFieldsSchema }),
  Data.Object({
    MemberAccount: Data.Object({
      /** The Fund State NFT token name this account belongs to. */
      fund_id: Data.Bytes(),
      /** The member's current share units. */
      share_units: Data.Integer(),
      /** Cumulative social-fund contributions (history, not redeemable). */
      social_paid: Data.Integer(),
      /** Outstanding loan principal (0 = no active loan); locks shares. */
      borrowed: Data.Integer(),
      /** Standing-layer event-capture consent (credentials, not scores). */
      consent: Data.Boolean(),
      joined_at: Data.Integer(),
    }),
  }),
  Data.Object({
    LoanAccount: Data.Object({
      /** The Fund State NFT token name this loan belongs to. */
      fund_id: Data.Bytes(),
      /** The borrower's member (100) reference-token name. */
      borrower_ref: Data.Bytes(),
      principal: Data.Integer(),
      /** Remaining principal; repayments reduce it. */
      outstanding: Data.Integer(),
      /** Flat charge fixed at disbursement (never compounds). */
      service_charge: Data.Integer(),
      /** Charge repaid so far (income — flows to the pot). */
      charge_paid: Data.Integer(),
      /** POSIX ms repayment deadline. */
      due: Data.Integer(),
      /** Ms after due before Late -> Defaulted; fixed at disbursement. */
      grace: Data.Integer(),
      status: LoanStatusSchema,
    }),
  }),
]);
export type SavingsDatum = Data.Static<typeof SavingsDatumSchema>;
export const SavingsDatum = SavingsDatumSchema as unknown as SavingsDatum;

export type MemberAccountFields = Extract<
  SavingsDatum,
  { MemberAccount: unknown }
>["MemberAccount"];

export type LoanAccountFields = Extract<
  SavingsDatum,
  { LoanAccount: unknown }
>["LoanAccount"];

// --- Redeemers (constructor order matches savings/types.ak exactly) ---

export const SavingsSpendRedeemerSchema = Data.Enum([
  Data.Object({
    Deposit: Data.Object({
      fund_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      member_output_index: Data.Integer(),
      fund_tag: Data.Integer(),
    }),
  }),
  Data.Object({
    Withdraw: Data.Object({
      fund_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      member_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    SocialPayout: Data.Object({
      fund_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    UpdateFund: Data.Object({
      fund_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    CloseCycle: Data.Object({
      fund_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ClaimShareOut: Data.Object({
      fund_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      member_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    DisburseLoan: Data.Object({
      fund_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      seed_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      member_output_index: Data.Integer(),
      loan_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    RepayLoan: Data.Object({
      fund_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      loan_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      member_output_index: Data.Integer(),
      /** 99 closes the loan (BurnLoan pairs). */
      loan_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    MarkArrears: Data.Object({
      loan_input_index: Data.Integer(),
      loan_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    WriteOffLoan: Data.Object({
      fund_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      loan_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      member_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    RemoveAccount: Data.Object({ member_input_index: Data.Integer() }),
  }),
  Data.Object({
    CloseFund: Data.Object({ fund_input_index: Data.Integer() }),
  }),
]);
export type SavingsSpendRedeemer = Data.Static<
  typeof SavingsSpendRedeemerSchema
>;
export const SavingsSpendRedeemer =
  SavingsSpendRedeemerSchema as unknown as SavingsSpendRedeemer;

export const SavingsMintRedeemerSchema = Data.Enum([
  Data.Object({
    CreateFund: Data.Object({
      seed_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    MintAccount: Data.Object({
      seed_input_index: Data.Integer(),
      /** Index into the ledger's SORTED reference-input set. */
      fund_ref_index: Data.Integer(),
      ref_output_index: Data.Integer(),
      user_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    MintLoan: Data.Object({ seed_input_index: Data.Integer() }),
  }),
  Data.Literal("BurnLoan"),
  Data.Literal("BurnAccount"),
  Data.Literal("BurnFund"),
]);
export type SavingsMintRedeemer = Data.Static<typeof SavingsMintRedeemerSchema>;
export const SavingsMintRedeemer =
  SavingsMintRedeemerSchema as unknown as SavingsMintRedeemer;

// --- Deposit tags (spec 3.3 Deposit) ---

export const FUND_TAG_SAVINGS = 0n;
export const FUND_TAG_SOCIAL = 1n;
export const FUND_TAG_TOPUP = 2n;

// --- address-first party input (same convention as escrow v2) ---

export type CredentialD = Data.Static<typeof CredentialSchema>;

/**
 * How endpoints accept a party: a plain bech32 address (the normal,
 * user-friendly form — the SDK derives the payment credential), or an
 * explicit credential for script/advanced callers.
 */
export type PartyRef = string | { type: "Key" | "Script"; hash: string };

/** Normalizes a PartyRef to the on-chain credential representation. */
export const partyToCredential = (
  party: PartyRef,
  configKey: string,
): Effect.Effect<CredentialD, ConfigurationError> =>
  Effect.try({
    try: () => {
      if (typeof party === "string") {
        const pc = getAddressDetails(party).paymentCredential;
        if (!pc) throw new Error("address has no payment credential");
        return pc.type === "Key"
          ? { VerificationKey: [pc.hash] as [string] }
          : { Script: [pc.hash] as [string] };
      }
      return party.type === "Key"
        ? { VerificationKey: [party.hash] as [string] }
        : { Script: [party.hash] as [string] };
    },
    catch: (e) =>
      new ConfigurationError({
        configKey,
        message: `cannot derive a credential from the given party: ${String(e)}`,
      }),
  });
