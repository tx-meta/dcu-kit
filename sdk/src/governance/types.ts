import { Data, getAddressDetails } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { ConfigurationError } from "../core/errors.js";
import { CredentialSchema } from "../core/types.js";

// Datum + redeemer schemas for the governance module. Field names and
// constructor order match onchain/governance/lib/governance/types.ak exactly.

// --- Voting weight rule ---

export const VotingModeSchema = Data.Enum([
  Data.Literal("OneMemberOneVote"),
  Data.Object({
    ShareWeighted: Data.Object({
      /** The savings account policy whose share_units become the vote weight. */
      share_source_policy: Data.Bytes(),
    }),
  }),
]);
export type VotingMode = Data.Static<typeof VotingModeSchema>;
export const VotingMode = VotingModeSchema as unknown as VotingMode;

// --- Who may open a proposal of a given action class ---

export const OpenerPolicySchema = Data.Enum([
  Data.Literal("AnyMember"),
  Data.Literal("CreatorOnly"),
]);
export type OpenerPolicy = Data.Static<typeof OpenerPolicySchema>;
export const OpenerPolicy = OpenerPolicySchema as unknown as OpenerPolicy;

// --- Proposal lifecycle ---

export const ProposalStatusSchema = Data.Enum([
  Data.Literal("Open"),
  Data.Literal("Passed"),
  Data.Literal("Rejected"),
  Data.Literal("Executed"),
  Data.Literal("Expired"),
]);
export type ProposalStatus = Data.Static<typeof ProposalStatusSchema>;
export const ProposalStatus = ProposalStatusSchema as unknown as ProposalStatus;

// --- The closed action set governance can authorize ---

export const GovActionSchema = Data.Enum([
  Data.Object({
    ParamChange: Data.Object({
      field_tag: Data.Integer(),
      new_value: Data.Integer(),
    }),
  }),
  Data.Object({
    SocialPayout: Data.Object({
      recipient: Data.Bytes(),
      amount: Data.Integer(),
    }),
  }),
  Data.Object({
    WriteOff: Data.Object({ loan_id: Data.Bytes() }),
  }),
  Data.Object({
    TreasuryMove: Data.Object({
      recipient: Data.Bytes(),
      amount: Data.Integer(),
    }),
  }),
  Data.Object({
    MembershipChange: Data.Object({
      member: Data.Bytes(),
      admit: Data.Boolean(),
    }),
  }),
]);
export type GovAction = Data.Static<typeof GovActionSchema>;
export const GovAction = GovActionSchema as unknown as GovAction;

/** GovAction constructor tags (index into GovActionSchema) — opener_policy keys. */
export const GOV_ACTION_TAG = {
  ParamChange: 0n,
  SocialPayout: 1n,
  WriteOff: 2n,
  TreasuryMove: 3n,
  MembershipChange: 4n,
} as const;

// --- Datum at the dispatcher address (charter + proposals) ---

export const GovernanceAnchorFieldsSchema = Data.Object({
  /** Human-readable instance name (group-level, not PII). */
  title: Data.Bytes(),
  /** Eligibility token policy: holding one makes a voter. */
  member_policy: Data.Bytes(),
  /** Target ids (vault anchor names / policies) this instance may govern. */
  governed_targets: Data.Array(Data.Bytes()),
  /** Default weight rule, copied into each proposal at open. */
  voting_mode: VotingModeSchema,
  /** Minimum total weight cast (yes + no) for a proposal to be decidable. */
  default_quorum: Data.Integer(),
  /** Minimum yes weight in basis points (0..10000) of weight cast, to pass. */
  default_threshold: Data.Integer(),
  /** Per-action-class opener rule, keyed by GovAction constructor tag. */
  opener_policy: Data.Map(Data.Integer(), OpenerPolicySchema),
  /** Ms between Passed and the earliest Executed (0 = no delay). */
  timelock: Data.Integer(),
  /** The instance creator (bootstrap opener and charter amender). */
  creator: CredentialSchema,
  /** Published hash of the Governance Voting Validator. Immutable. */
  voting_stake_hash: Data.Bytes(),
  /** Published hash of the Governance Gate Validator. Immutable. */
  gate_hash: Data.Bytes(),
});
export type GovernanceAnchorFields = Data.Static<
  typeof GovernanceAnchorFieldsSchema
>;

export const ProposalFieldsSchema = Data.Object({
  /** The Proposal State NFT name. */
  proposal_id: Data.Bytes(),
  /** The single vault this proposal governs (a member of governed_targets). */
  target_id: Data.Bytes(),
  /** The typed, parameterized action to authorize. */
  action: GovActionSchema,
  /** Frozen from the charter at open. */
  voting_mode: VotingModeSchema,
  quorum: Data.Integer(),
  threshold: Data.Integer(),
  /** POSIX ms; voting closes at this bound. */
  deadline: Data.Integer(),
  /** POSIX ms by which a passed proposal must execute (null = never). */
  exec_deadline: Data.Nullable(Data.Integer()),
  /** Set when the proposal passes (= now + charter.timelock). */
  timelock_until: Data.Nullable(Data.Integer()),
  /** Running weight for and against. */
  tally_yes: Data.Integer(),
  tally_no: Data.Integer(),
  /** Count of distinct voters recorded (turnout). */
  votes_cast: Data.Integer(),
  status: ProposalStatusSchema,
});
export type ProposalFields = Data.Static<typeof ProposalFieldsSchema>;

export const GovernanceDatumSchema = Data.Enum([
  Data.Object({ GovernanceAnchor: GovernanceAnchorFieldsSchema }),
  Data.Object({ Proposal: ProposalFieldsSchema }),
]);
export type GovernanceDatum = Data.Static<typeof GovernanceDatumSchema>;
export const GovernanceDatum =
  GovernanceDatumSchema as unknown as GovernanceDatum;

// --- Datum at the gate address (locked with the decision token) ---

export const DecisionFieldsSchema = Data.Object({
  /** The vault this decision authorizes. */
  target_id: Data.Bytes(),
  /** The exact action authorized, with parameters. */
  action: GovActionSchema,
  /** POSIX ms after which the decision is dead even if unspent. */
  exec_deadline: Data.Nullable(Data.Integer()),
});
export type DecisionFields = Data.Static<typeof DecisionFieldsSchema>;

// GateDatum has a single Aiken constructor (Decision), so it encodes as
// Constr(0, [fields]) — the plain fields object, with no variant wrapper.
export const GateDatumSchema = DecisionFieldsSchema;
export type GateDatum = Data.Static<typeof GateDatumSchema>;
export const GateDatum = GateDatumSchema as unknown as GateDatum;

// --- Redeemers (constructor order matches governance/types.ak exactly) ---

// SettingsRedeemer has a single Aiken constructor (MintAnchor), so it encodes
// as Constr(0, [anchor_output_index]) — plain fields, no variant wrapper.
export const SettingsRedeemerSchema = Data.Object({
  anchor_output_index: Data.Integer(),
});
export type SettingsRedeemer = Data.Static<typeof SettingsRedeemerSchema>;
export const SettingsRedeemer =
  SettingsRedeemerSchema as unknown as SettingsRedeemer;

export const GovMintRedeemerSchema = Data.Enum([
  Data.Object({
    OpenProposal: Data.Object({
      seed_input_index: Data.Integer(),
      proposal_output_index: Data.Integer(),
      withdrawal_index: Data.Integer(),
    }),
  }),
  Data.Object({
    CastVote: Data.Object({
      proposal_input_index: Data.Integer(),
      receipt_output_index: Data.Integer(),
      voter_index: Data.Integer(),
      withdrawal_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ExecuteProposal: Data.Object({
      proposal_input_index: Data.Integer(),
      decision_output_index: Data.Integer(),
      withdrawal_index: Data.Integer(),
    }),
  }),
  Data.Object({
    BurnProposal: Data.Object({ withdrawal_index: Data.Integer() }),
  }),
  Data.Literal("BurnDecision"),
]);
export type GovMintRedeemer = Data.Static<typeof GovMintRedeemerSchema>;
export const GovMintRedeemer =
  GovMintRedeemerSchema as unknown as GovMintRedeemer;

export const GovSpendRedeemerSchema = Data.Enum([
  Data.Object({
    Vote: Data.Object({
      anchor_ref_index: Data.Integer(),
      proposal_input_index: Data.Integer(),
      proposal_output_index: Data.Integer(),
      voter_index: Data.Integer(),
      /** 99 under OneMemberOneVote (no share reference input read). */
      share_ref_index: Data.Integer(),
      approve: Data.Boolean(),
      withdrawal_index: Data.Integer(),
    }),
  }),
  Data.Object({
    Finalize: Data.Object({
      anchor_ref_index: Data.Integer(),
      proposal_input_index: Data.Integer(),
      proposal_output_index: Data.Integer(),
      withdrawal_index: Data.Integer(),
    }),
  }),
  Data.Object({
    Execute: Data.Object({
      anchor_ref_index: Data.Integer(),
      proposal_input_index: Data.Integer(),
      proposal_output_index: Data.Integer(),
      decision_output_index: Data.Integer(),
      withdrawal_index: Data.Integer(),
    }),
  }),
  Data.Object({
    Expire: Data.Object({
      proposal_input_index: Data.Integer(),
      withdrawal_index: Data.Integer(),
    }),
  }),
  Data.Object({
    UpdateCharter: Data.Object({
      anchor_input_index: Data.Integer(),
      anchor_output_index: Data.Integer(),
    }),
  }),
]);
export type GovSpendRedeemer = Data.Static<typeof GovSpendRedeemerSchema>;
export const GovSpendRedeemer =
  GovSpendRedeemerSchema as unknown as GovSpendRedeemer;

export const VotingActionSchema = Data.Enum([
  Data.Object({
    OpenAction: Data.Object({
      proposal_output_index: Data.Integer(),
      opener_index: Data.Integer(),
    }),
  }),
  Data.Object({
    CastAction: Data.Object({
      proposal_input_index: Data.Integer(),
      proposal_output_index: Data.Integer(),
      voter_index: Data.Integer(),
      share_ref_index: Data.Integer(),
      approve: Data.Boolean(),
    }),
  }),
  Data.Object({
    FinalizeAction: Data.Object({
      proposal_input_index: Data.Integer(),
      proposal_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ExecuteAction: Data.Object({
      proposal_input_index: Data.Integer(),
      proposal_output_index: Data.Integer(),
      decision_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ExpireAction: Data.Object({ proposal_input_index: Data.Integer() }),
  }),
]);
export type VotingAction = Data.Static<typeof VotingActionSchema>;
export const VotingAction = VotingActionSchema as unknown as VotingAction;

// GateRedeemer has a single Aiken constructor (Authorize), so it encodes as
// Constr(0, [decision_input_index, target_input_index]) — no variant wrapper.
export const GateRedeemerSchema = Data.Object({
  decision_input_index: Data.Integer(),
  target_input_index: Data.Integer(),
});
export type GateRedeemer = Data.Static<typeof GateRedeemerSchema>;
export const GateRedeemer = GateRedeemerSchema as unknown as GateRedeemer;

/** Sentinel: no share reference input read (OneMemberOneVote). */
export const NO_SHARE_REF = 99n;

// --- address-first party input (same convention as escrow/savings) ---

export type CredentialD = Data.Static<typeof CredentialSchema>;

/**
 * How endpoints accept a party: a plain bech32 address (the normal form — the
 * SDK derives the payment credential), or an explicit credential for
 * script/advanced callers.
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
