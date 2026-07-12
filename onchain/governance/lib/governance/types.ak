use cardano/address.{Credential}
use cardano/assets.{AssetName, PolicyId}

// [spec 3.3]: voting weight rule, frozen into each proposal at open.
// Default is one-member-one-vote (the cooperative principle and the
// anti-plutocracy default); share-weighted is opt-in for share-natural
// decisions and reads the savings share balance as a reference input.
pub type VotingMode {
  OneMemberOneVote
  ShareWeighted { share_source_policy: PolicyId }
}

// [spec 3.3]: who may open a proposal of a given action class.
pub type OpenerPolicy {
  AnyMember
  CreatorOnly
}

// [spec 3.3]: proposal lifecycle. Open -> Passed|Rejected -> Executed|Expired.
pub type ProposalStatus {
  Open
  Passed
  Rejected
  Executed
  Expired
}

// [spec 3.3]: the closed action set governance can authorize. Fixed, not
// configurable — an open action space cannot be exhaustively validated
// on-chain, and each variant is a distinct gate check.
pub type GovAction {
  ParamChange { field_tag: Int, new_value: Int }
  SocialPayout { recipient: ByteArray, amount: Int }
  WriteOff { loan_id: AssetName }
  TreasuryMove { recipient: ByteArray, amount: Int }
  MembershipChange { member: AssetName, admit: Bool }
}

// [spec 3.3]: datum at the dispatcher address — the charter (with published
// validator hashes) and every open/decided proposal. No PII, ever.
pub type GovernanceDatum {
  GovernanceAnchor {
    // Human-readable instance name (group-level, not PII).
    title: ByteArray,
    // Eligibility token policy: holding a token of this policy makes a voter
    // (e.g. the savings account user-token policy).
    member_policy: PolicyId,
    // Target ids (vault anchor names / policies) this instance may govern.
    governed_targets: List<ByteArray>,
    // Default weight rule, copied into each proposal at open.
    voting_mode: VotingMode,
    // Minimum total weight CAST (yes + no) for a proposal to be decidable.
    default_quorum: Int,
    // Minimum yes weight as basis points (0..10000) of weight cast, to pass.
    default_threshold: Int,
    // Per-action-class opener rule, keyed by GovAction constructor tag.
    opener_policy: Pairs<Int, OpenerPolicy>,
    // Ms between Passed and the earliest Executed (0 = no delay).
    timelock: Int,
    // The instance creator (bootstrap opener and charter amender).
    creator: Credential,
    // Published hash of the Governance Voting Validator. Immutable.
    voting_stake_hash: ByteArray,
    // Published hash of the Governance Gate Validator. Immutable.
    gate_hash: ByteArray,
  }
  Proposal {
    // The Proposal State NFT name.
    proposal_id: AssetName,
    // The single vault this proposal governs (a member of governed_targets).
    target_id: ByteArray,
    // The typed, parameterized action to authorize.
    action: GovAction,
    // Frozen from the charter at open.
    voting_mode: VotingMode,
    quorum: Int,
    threshold: Int,
    // POSIX ms; voting closes at this bound.
    deadline: Int,
    // POSIX ms by which a passed proposal must execute (None = never expires).
    exec_deadline: Option<Int>,
    // Set when the proposal passes (= now + charter.timelock).
    timelock_until: Option<Int>,
    // Running weight for and against.
    tally_yes: Int,
    tally_no: Int,
    // Count of distinct voters recorded (turnout).
    votes_cast: Int,
    status: ProposalStatus,
  }
}

// [spec 3.3]: datum at the gate address, locked with the decision token.
pub type GateDatum {
  Decision {
    // The vault this decision authorizes.
    target_id: ByteArray,
    // The exact action authorized, with parameters.
    action: GovAction,
    // POSIX ms after which the decision is dead even if unspent.
    exec_deadline: Option<Int>,
  }
}

// [spec 3.3.2]: Governance Settings Policy mint redeemer.
pub type SettingsRedeemer {
  // One-shot Anchor NFT from the consumed seed input.
  MintAnchor { seed_input_index: Int, anchor_output_index: Int }
}

// [spec 3.3.3]: Governance Dispatcher mint redeemer. Every variant except
// BurnDecision couples to a Governance Voting withdrawal (withdraw-zero).
pub type GovMintRedeemer {
  OpenProposal {
    seed_input_index: Int,
    proposal_output_index: Int,
    withdrawal_index: Int,
  }
  CastVote {
    proposal_input_index: Int,
    receipt_output_index: Int,
    voter_index: Int,
    withdrawal_index: Int,
  }
  ExecuteProposal {
    proposal_input_index: Int,
    decision_output_index: Int,
    withdrawal_index: Int,
  }
  BurnProposal { withdrawal_index: Int }
  BurnDecision
}

// [spec 3.3.3]: Governance Dispatcher spend redeemer. Guards the Anchor
// (UpdateCharter) and every Proposal (Vote/Finalize/Execute/Expire). Each
// defers the heavy check to the coupled Governance Voting withdrawal.
pub type GovSpendRedeemer {
  Vote {
    anchor_ref_index: Int,
    proposal_input_index: Int,
    proposal_output_index: Int,
    voter_index: Int,
    // 99 under OneMemberOneVote (no share reference input read).
    share_ref_index: Int,
    approve: Bool,
    withdrawal_index: Int,
  }
  Finalize {
    anchor_ref_index: Int,
    proposal_input_index: Int,
    proposal_output_index: Int,
    withdrawal_index: Int,
  }
  Execute {
    anchor_ref_index: Int,
    proposal_input_index: Int,
    proposal_output_index: Int,
    decision_output_index: Int,
    withdrawal_index: Int,
  }
  Expire { proposal_input_index: Int, withdrawal_index: Int }
  UpdateCharter { anchor_input_index: Int, anchor_output_index: Int }
}

// [spec 3.3.4]: Governance Voting withdraw redeemer — the withdraw-zero home
// of all heavy validation, one transition per proposal spend.
pub type VotingAction {
  OpenAction { proposal_output_index: Int, opener_index: Int }
  CastAction {
    proposal_input_index: Int,
    proposal_output_index: Int,
    voter_index: Int,
    share_ref_index: Int,
    approve: Bool,
  }
  FinalizeAction { proposal_input_index: Int, proposal_output_index: Int }
  ExecuteAction {
    proposal_input_index: Int,
    proposal_output_index: Int,
    decision_output_index: Int,
  }
  ExpireAction { proposal_input_index: Int }
}

// [spec 3.3.5]: Governance Gate spend redeemer — authorize one vault action
// against one decision, then burn it.
pub type GateRedeemer {
  Authorize { decision_input_index: Int, target_input_index: Int }
}
