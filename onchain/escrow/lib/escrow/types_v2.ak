use cardano/address.{Address, Credential}
use cardano/assets.{AssetName, PolicyId}

// [spec 3.1]: v2 milestone — amount in the escrow asset's smallest unit plus its
// own POSIX-ms deadline. Deadlines are strictly increasing across the schedule.
pub type Milestone {
  amount: Int,
  deadline: Int,
}

pub type FundingMode {
  Upfront
  PerMilestone
}

// [spec 3.2]: what happens when a milestone's cure window passes without a
// verifier verdict — the funder reclaims (v2 base) or the tranche becomes
// releasable to the beneficiary (silence approves).
pub type TimeoutPolicy {
  RefundToFunder
  ReleaseToBeneficiary
}

// One dispute per milestone, maximum. The record is never cleared — a lapsed
// dispute for milestone i simply stops freezing once past `until`, and blocks a
// second raise for the same milestone.
pub type DisputeInfo {
  milestone: Int,
  until: Int,
}

pub type EscrowDatumV2 {
  funder: Address,
  beneficiary: Address,
  // Authority only — never receives funds, so a bare credential suffices.
  verifier: Credential,
  // Neutral tie-breaker; None = no dispute path exists for this escrow.
  arbiter: Option<Credential>,
  asset_policy: PolicyId,
  asset_name: AssetName,
  milestones: List<Milestone>,
  grace: Int,
  dispute_window: Int,
  released_count: Int,
  funding_mode: FundingMode,
  timeout_policy: TimeoutPolicy,
  dispute: Option<DisputeInfo>,
  title: ByteArray,
  content_hash: Option<ByteArray>,
  evidence: List<Option<ByteArray>>,
  // Opaque pointer to a Project NFT name; the escrow validator never reads it.
  project_id: Option<ByteArray>,
}

pub type Party {
  FunderParty
  BeneficiaryParty
  VerifierParty
  ArbiterParty
}

pub type EscrowV2SpendRedeemer {
  ReleaseV2 {
    escrow_input_index: Int,
    continuation_index: Int,
    payout_index: Int,
    funder_index: Int,
  }
  TimeoutReleaseV2 {
    escrow_input_index: Int,
    continuation_index: Int,
    payout_index: Int,
    funder_index: Int,
  }
  ReclaimV2 { escrow_input_index: Int, refund_index: Int }
  AbortV2 { escrow_input_index: Int }
  Contribute { escrow_input_index: Int, continuation_index: Int }
  SubmitEvidence {
    escrow_input_index: Int,
    continuation_index: Int,
    milestone_index: Int,
    evidence_hash: ByteArray,
  }
  RotateParty { escrow_input_index: Int, continuation_index: Int, party: Party }
  AmendMilestones {
    escrow_input_index: Int,
    continuation_index: Int,
    funder_index: Int,
  }
  RaiseDispute { escrow_input_index: Int, continuation_index: Int }
  ResolveDispute { escrow_input_index: Int }
}

pub type EscrowV2MintRedeemer {
  CreateEscrowV2 { seed_input_index: Int, escrow_output_index: Int }
  BurnEscrowV2
}

// [spec 3.4]: passive anchor — identity + metadata + status, freely mutable by
// its owner. Escrows bind by the opaque token name, never by UTxO reference.
pub type ProjectDatum {
  title: ByteArray,
  content_hash: Option<ByteArray>,
  // 0 = Active, 1 = Closed.
  status: Int,
  owner: Credential,
}

pub type ProjectSpendRedeemer {
  UpdateProject { project_input_index: Int, continuation_index: Int }
  CloseProject { project_input_index: Int }
}

pub type ProjectMintRedeemer {
  CreateProject { seed_input_index: Int, project_output_index: Int }
  BurnProject
}
