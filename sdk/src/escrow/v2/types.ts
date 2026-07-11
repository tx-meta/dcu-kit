import { Data, getAddressDetails } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { CredentialSchema } from "../../core/types.js";
import { ConfigurationError } from "../../core/errors.js";
import { AddressSchema } from "../types.js";

export {
  AddressD,
  AddressSchema,
  fromOnchainAddress,
  toOnchainAddress,
} from "../types.js";

// --- v2 datum building blocks (mirror onchain/escrow/lib/escrow/types_v2.ak) ---

export const MilestoneSchema = Data.Object({
  /** Tranche amount in the escrowed asset's smallest unit. */
  amount: Data.Integer(),
  /** POSIX ms deadline; strictly increasing across the schedule. */
  deadline: Data.Integer(),
});
export type MilestoneD = Data.Static<typeof MilestoneSchema>;
export const MilestoneD = MilestoneSchema as unknown as MilestoneD;

export const FundingModeSchema = Data.Enum([
  Data.Literal("Upfront"),
  Data.Literal("PerMilestone"),
]);
export type FundingModeD = Data.Static<typeof FundingModeSchema>;
export const FundingModeD = FundingModeSchema as unknown as FundingModeD;

export const TimeoutPolicySchema = Data.Enum([
  Data.Literal("RefundToFunder"),
  Data.Literal("ReleaseToBeneficiary"),
]);
export type TimeoutPolicyD = Data.Static<typeof TimeoutPolicySchema>;
export const TimeoutPolicyD = TimeoutPolicySchema as unknown as TimeoutPolicyD;

export const DisputeInfoSchema = Data.Object({
  milestone: Data.Integer(),
  until: Data.Integer(),
});
export type DisputeInfoD = Data.Static<typeof DisputeInfoSchema>;
export const DisputeInfoD = DisputeInfoSchema as unknown as DisputeInfoD;

export const EscrowDatumV2Schema = Data.Object({
  /** Refund destination + abort/amend co-authority (full address). */
  funder: AddressSchema,
  /** Payout destination + abort/amend co-authority (full address). */
  beneficiary: AddressSchema,
  /** Release authority — never receives funds. VK or script (e.g. multisig). */
  verifier: CredentialSchema,
  /** Neutral tie-breaker; null = this escrow has no dispute path. */
  arbiter: Data.Nullable(CredentialSchema),
  /** Policy ID of the escrowed asset. Empty string (`""`) means ADA. */
  asset_policy: Data.Bytes(),
  /** Asset name of the escrowed asset. Empty string (`""`) means ADA. */
  asset_name: Data.Bytes(),
  /** 1-100 milestones, amounts > 0, deadlines strictly increasing. */
  milestones: Data.Array(MilestoneSchema),
  /** Cure window (ms) added to every deadline; fixed at create. */
  grace: Data.Integer(),
  /** Freeze duration (ms) of a raised dispute; fixed at create. */
  dispute_window: Data.Integer(),
  /** Tranches released so far. Advances by exactly 1 per release. */
  released_count: Data.Integer(),
  funding_mode: FundingModeSchema,
  timeout_policy: TimeoutPolicySchema,
  /** Active/lapsed dispute marker — one dispute per milestone, never cleared. */
  dispute: Data.Nullable(DisputeInfoSchema),
  /** Short inline title (max 64 bytes UTF-8, hex-encoded on-chain). */
  title: Data.Bytes(),
  /** Hash of the off-chain terms document (IPFS CID or any URL's content). */
  content_hash: Data.Nullable(Data.Bytes()),
  /** Per-milestone deliverable evidence hashes; beneficiary-written. */
  evidence: Data.Array(Data.Nullable(Data.Bytes())),
  /** Opaque Project token name; the escrow validator never reads it. */
  project_id: Data.Nullable(Data.Bytes()),
});
export type EscrowDatumV2 = Data.Static<typeof EscrowDatumV2Schema>;
export const EscrowDatumV2 = EscrowDatumV2Schema as unknown as EscrowDatumV2;

export const PartySchema = Data.Enum([
  Data.Literal("FunderParty"),
  Data.Literal("BeneficiaryParty"),
  Data.Literal("VerifierParty"),
  Data.Literal("ArbiterParty"),
]);
export type PartyD = Data.Static<typeof PartySchema>;
export const PartyD = PartySchema as unknown as PartyD;

export const EscrowV2SpendRedeemerSchema = Data.Enum([
  Data.Object({
    ReleaseV2: Data.Object({
      escrow_input_index: Data.Integer(),
      continuation_index: Data.Integer(),
      payout_index: Data.Integer(),
      funder_index: Data.Integer(),
    }),
  }),
  Data.Object({
    TimeoutReleaseV2: Data.Object({
      escrow_input_index: Data.Integer(),
      continuation_index: Data.Integer(),
      payout_index: Data.Integer(),
      funder_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ReclaimV2: Data.Object({
      escrow_input_index: Data.Integer(),
      refund_index: Data.Integer(),
    }),
  }),
  Data.Object({
    AbortV2: Data.Object({ escrow_input_index: Data.Integer() }),
  }),
  Data.Object({
    Contribute: Data.Object({
      escrow_input_index: Data.Integer(),
      continuation_index: Data.Integer(),
    }),
  }),
  Data.Object({
    SubmitEvidence: Data.Object({
      escrow_input_index: Data.Integer(),
      continuation_index: Data.Integer(),
      milestone_index: Data.Integer(),
      evidence_hash: Data.Bytes(),
    }),
  }),
  Data.Object({
    RotateParty: Data.Object({
      escrow_input_index: Data.Integer(),
      continuation_index: Data.Integer(),
      party: PartySchema,
    }),
  }),
  Data.Object({
    AmendMilestones: Data.Object({
      escrow_input_index: Data.Integer(),
      continuation_index: Data.Integer(),
      funder_index: Data.Integer(),
    }),
  }),
  Data.Object({
    RaiseDispute: Data.Object({
      escrow_input_index: Data.Integer(),
      continuation_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ResolveDispute: Data.Object({ escrow_input_index: Data.Integer() }),
  }),
]);
export type EscrowV2SpendRedeemer = Data.Static<
  typeof EscrowV2SpendRedeemerSchema
>;
export const EscrowV2SpendRedeemer =
  EscrowV2SpendRedeemerSchema as unknown as EscrowV2SpendRedeemer;

export const EscrowV2MintRedeemerSchema = Data.Enum([
  Data.Object({
    CreateEscrowV2: Data.Object({
      seed_input_index: Data.Integer(),
      escrow_output_index: Data.Integer(),
    }),
  }),
  Data.Literal("BurnEscrowV2"),
]);
export type EscrowV2MintRedeemer = Data.Static<
  typeof EscrowV2MintRedeemerSchema
>;
export const EscrowV2MintRedeemer =
  EscrowV2MintRedeemerSchema as unknown as EscrowV2MintRedeemer;

// --- Project anchor ---

export const ProjectDatumSchema = Data.Object({
  /** Short inline title (max 64 bytes). */
  title: Data.Bytes(),
  /** Hash of the off-chain project document. */
  content_hash: Data.Nullable(Data.Bytes()),
  /** 0 = Active, 1 = Closed. */
  status: Data.Integer(),
  /** Generic owner credential — individual, multisig, or a group. */
  owner: CredentialSchema,
});
export type ProjectDatum = Data.Static<typeof ProjectDatumSchema>;
export const ProjectDatum = ProjectDatumSchema as unknown as ProjectDatum;

export const ProjectSpendRedeemerSchema = Data.Enum([
  Data.Object({
    UpdateProject: Data.Object({
      project_input_index: Data.Integer(),
      continuation_index: Data.Integer(),
    }),
  }),
  Data.Object({
    CloseProject: Data.Object({ project_input_index: Data.Integer() }),
  }),
]);
export type ProjectSpendRedeemer = Data.Static<
  typeof ProjectSpendRedeemerSchema
>;
export const ProjectSpendRedeemer =
  ProjectSpendRedeemerSchema as unknown as ProjectSpendRedeemer;

export const ProjectMintRedeemerSchema = Data.Enum([
  Data.Object({
    CreateProject: Data.Object({
      seed_input_index: Data.Integer(),
      project_output_index: Data.Integer(),
    }),
  }),
  Data.Literal("BurnProject"),
]);
export type ProjectMintRedeemer = Data.Static<
  typeof ProjectMintRedeemerSchema
>;
export const ProjectMintRedeemer =
  ProjectMintRedeemerSchema as unknown as ProjectMintRedeemer;

// --- address-first party input ---

export type CredentialD = Data.Static<typeof CredentialSchema>;

/**
 * How every v2 endpoint accepts a party: a plain bech32 address (the normal,
 * user-friendly form — the SDK derives the payment credential), or an explicit
 * credential for script/advanced callers. No UI should ever ask a human for a
 * credential hash.
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
