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

/**
 * The audited fund taxonomies. Only these four values validate at creation.
 *
 * `Welfare` funds never sell shares, so they close with an empty pot once their
 * welfare is disbursed; every other type closes on a share-out.
 */
export const GroupType = {
  Asca: 0n,
  Vsla: 1n,
  Welfare: 2n,
  Pool: 3n,
} as const;

export type GroupTypeValue = (typeof GroupType)[keyof typeof GroupType];

export const SavingsFundFieldsSchema = Data.Object({
  /** Short inline fund name (max 64 bytes). Group-level only, never PII. */
  title: Data.Bytes(),
  /**
   * Fund taxonomy, fixed at creation — see {@link GroupType}. Immutable: a fund
   * cannot change what kind of fund it is, so the audited configuration a member
   * joined under governs it for life.
   */
  group_type: Data.Integer(),
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

// --- Governance intent commitments ---

const SavingsStakeCredentialSchema = Data.Enum([
  Data.Object({ Inline: Data.Tuple([CredentialSchema]) }),
  Data.Object({
    Pointer: Data.Tuple([Data.Integer(), Data.Integer(), Data.Integer()]),
  }),
]);

export const SavingsAddressSchema = Data.Object({
  payment_credential: CredentialSchema,
  stake_credential: Data.Nullable(SavingsStakeCredentialSchema),
});
export type SavingsAddress = Data.Static<typeof SavingsAddressSchema>;

/** Mirrors `SavingsIntent` in on-chain constructor order. */
export const SavingsIntentSchema = Data.Enum([
  Data.Object({
    SocialPayoutIntent: Data.Object({
      destination: SavingsAddressSchema,
      amount: Data.Integer(),
    }),
  }),
  Data.Object({
    UpdateFundIntent: Data.Object({
      title: Data.Bytes(),
      quorum: CredentialSchema,
      min_shares_per_deposit: Data.Integer(),
      max_shares_per_deposit: Data.Integer(),
      max_loan_multiple: Data.Integer(),
      loan_grace: Data.Integer(),
      cycle_end: Data.Nullable(Data.Integer()),
    }),
  }),
  Data.Object({
    CloseCycleIntent: Data.Object({}),
  }),
  Data.Object({
    DisburseLoanIntent: Data.Object({ loan: SavingsDatumSchema }),
  }),
  Data.Object({
    WriteOffLoanIntent: Data.Object({ loan_id: Data.Bytes() }),
  }),
  Data.Object({
    CloseFundIntent: Data.Object({ destination: SavingsAddressSchema }),
  }),
]);
export type SavingsIntent = Data.Static<typeof SavingsIntentSchema>;
export const SavingsIntent = SavingsIntentSchema as unknown as SavingsIntent;

// --- Redeemers (constructor order matches savings/types.ak exactly) ---

/**
 * The vault's SPENDING redeemer (ADR-0003 two-family split).
 *
 * Every vault UTxO an operation consumes is spent with that operation's
 * constructor; the indices and routing data live on the family withdrawal
 * redeemer ({@link SavingsGovernedAction} / {@link SavingsDirectAction}).
 *
 * The six quorum-controlled operations keep `intent_hash` at FIELD 0. That is
 * the ABI the Governance Gate's `BoundIntent` arm reads (ADR-0002): the target's
 * spend-redeemer constructor plus its field 0. Constructor order is frozen.
 */
export const SavingsSpendRedeemerSchema = Data.Enum([
  Data.Literal("Deposit"),
  Data.Literal("Withdraw"),
  Data.Object({ SocialPayout: Data.Object({ intent_hash: Data.Bytes() }) }),
  Data.Object({ UpdateFund: Data.Object({ intent_hash: Data.Bytes() }) }),
  Data.Object({ CloseCycle: Data.Object({ intent_hash: Data.Bytes() }) }),
  Data.Literal("ClaimShareOut"),
  Data.Object({ DisburseLoan: Data.Object({ intent_hash: Data.Bytes() }) }),
  Data.Literal("RepayLoan"),
  Data.Literal("MarkArrears"),
  Data.Object({ WriteOffLoan: Data.Object({ intent_hash: Data.Bytes() }) }),
  Data.Literal("RemoveAccount"),
  Data.Object({ CloseFund: Data.Object({ intent_hash: Data.Bytes() }) }),
]);
export type SavingsSpendRedeemer = Data.Static<
  typeof SavingsSpendRedeemerSchema
>;
export const SavingsSpendRedeemer =
  SavingsSpendRedeemerSchema as unknown as SavingsSpendRedeemer;

/**
 * `savings_governed` family action — the six quorum-authorized operations.
 * Field 0 of every variant is `covered_inputs`, the vault inputs this action
 * validates (ADR-0003's coverage invariant).
 */
export const SavingsGovernedActionSchema = Data.Enum([
  Data.Object({
    SocialPayoutAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
      fund_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      payout_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    UpdateFundAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
      fund_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    CloseCycleAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
      fund_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    DisburseLoanAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
      fund_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      seed_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      member_output_index: Data.Integer(),
      loan_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    WriteOffLoanAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
      fund_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      loan_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      member_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    CloseFundAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
      fund_input_index: Data.Integer(),
      payout_output_index: Data.Integer(),
    }),
  }),
]);
export type SavingsGovernedAction = Data.Static<
  typeof SavingsGovernedActionSchema
>;
export const SavingsGovernedAction =
  SavingsGovernedActionSchema as unknown as SavingsGovernedAction;

/**
 * `savings_direct` family action — the six directly authorized operations
 * (member, borrower, or truthful elapsed time). Field 0 is `covered_inputs`.
 */
export const SavingsDirectActionSchema = Data.Enum([
  Data.Object({
    DepositAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
      fund_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      member_output_index: Data.Integer(),
      /** 0 buys shares, 1 feeds the social fund, 2 is an untagged top-up. */
      fund_tag: Data.Integer(),
    }),
  }),
  Data.Object({
    WithdrawAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
      fund_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      member_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ClaimShareOutAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
      fund_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      fund_output_index: Data.Integer(),
      member_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    RepayLoanAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
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
    MarkArrearsAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
      loan_input_index: Data.Integer(),
      loan_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    RemoveAccountAction: Data.Object({
      covered_inputs: Data.Array(Data.Integer()),
      member_input_index: Data.Integer(),
    }),
  }),
]);
export type SavingsDirectAction = Data.Static<typeof SavingsDirectActionSchema>;
export const SavingsDirectAction =
  SavingsDirectActionSchema as unknown as SavingsDirectAction;

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
