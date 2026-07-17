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
  // Forward-compatibility arm: action kinds designed AFTER this enum froze.
  // `tag` names the future kind, `payload` carries its CBOR-encoded parameters.
  // Governance treats it opaquely (freeze, tally, bind, burn — same as any
  // action); ONLY a vault version that decodes and understands a given tag may
  // act on it. Without this arm, any new action kind forces a governance v2.
  Generic { tag: Int, payload: ByteArray }
}

// [spec 3.3]: datum at the dispatcher address — the charter (with published
// validator hashes), every open/decided proposal, each member's voter record,
// and the registration roster. No PII, ever.
pub type GovernanceDatum {
  GovernanceAnchor {
    // Human-readable instance name (group-level, not PII).
    title: ByteArray,
    // Eligibility token policy: holding a token of this policy makes a voter
    // (e.g. the savings account user-token policy).
    member_policy: PolicyId,
    // The (policy, state-NFT name) of each vault this instance may govern.
    // Both halves are binding — a name alone is forgeable under any policy.
    governed_targets: Pairs<PolicyId, AssetName>,
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
    // The policy of the governed vault's state NFT.
    target_policy: PolicyId,
    // The state-NFT name of the single vault this proposal governs. The
    // (target_policy, target_id) pair must be a member of governed_targets.
    target_id: AssetName,
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
    // Set when the proposal passes (= finalize time + charter.timelock).
    timelock_until: Option<Int>,
    // Running weight for and against.
    tally_yes: Int,
    tally_no: Int,
    // Count of distinct voters recorded (turnout).
    votes_cast: Int,
    status: ProposalStatus,
  }
  // [spec 3.3 voter record]: one per registered member — the double-vote
  // nullifier. A vote SPENDS this UTxO and appends the proposal id to `voted`;
  // the ledger's own double-spend prevention makes concurrent double votes
  // impossible, and the appended list rejects sequential ones.
  VoterRecord {
    // The member's eligibility-token name this record is bound to.
    member_id: AssetName,
    // Proposal ids this member has already voted on.
    voted: List<AssetName>,
  }
  // [spec 3.3 roster]: the ever-registered member set (one per instance,
  // created at init). Registration appends and nothing removes — this is what
  // makes voter-record creation one-shot per member; a re-registration would
  // otherwise mint a fresh empty record and re-enable double voting.
  Roster { members: List<AssetName> }
}

// [spec 3.3]: datum at the gate address, locked with the decision token.
pub type GateDatum {
  Decision {
    // The policy of the vault state NFT this decision authorizes.
    target_policy: PolicyId,
    // The vault state-NFT name this decision authorizes.
    target_id: AssetName,
    // The exact action authorized, with parameters.
    action: GovAction,
    // POSIX ms after which the decision is dead even if unspent.
    exec_deadline: Option<Int>,
  }
}

// [spec 3.3.2]: Governance Settings Policy mint redeemer. The policy is
// parameterized by the seed OutputReference (one-shot per instance), so the
// settings_policy — and thus the whole instance's dispatcher/voting/gate
// hashes — are unique. This is what lets a vault's quorum Credential commit to
// ONE governance instance (cross-instance authorization is otherwise possible).
pub type SettingsRedeemer {
  // The seed is the compile parameter; the anchor and roster output indices
  // locate the two UTxOs the one-shot mint creates.
  MintAnchor { anchor_output_index: Int, roster_output_index: Int }
}

// [spec 3.3.3]: Governance Dispatcher mint redeemer. Every variant except
// BurnDecision couples to a Governance Voting withdrawal (withdraw-zero).
pub type GovMintRedeemer {
  OpenProposal {
    seed_input_index: Int,
    proposal_output_index: Int,
    withdrawal_index: Int,
  }
  RegisterVoter {
    roster_input_index: Int,
    record_output_index: Int,
    member_index: Int,
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
// (UpdateCharter), every Proposal (Vote/Finalize/Execute/Expire), the roster
// (RosterSpend, registration only) and each voter record (VoteRecordSpend,
// casting only). Each defers the heavy check to the coupled withdrawal.
pub type GovSpendRedeemer {
  Vote {
    anchor_ref_index: Int,
    proposal_input_index: Int,
    proposal_output_index: Int,
    voter_index: Int,
    record_input_index: Int,
    record_output_index: Int,
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
  VoteRecordSpend { withdrawal_index: Int }
  RosterSpend { withdrawal_index: Int }
}

// [spec 3.3.4]: Governance Voting withdraw redeemer — the withdraw-zero home
// of all heavy validation, one transition per proposal spend.
pub type VotingAction {
  OpenAction { proposal_output_index: Int, opener_index: Int }
  CastAction {
    proposal_input_index: Int,
    proposal_output_index: Int,
    voter_index: Int,
    record_input_index: Int,
    record_output_index: Int,
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
  RegisterAction {
    roster_input_index: Int,
    roster_output_index: Int,
    record_output_index: Int,
    member_index: Int,
  }
}

// [spec 3.3.5]: Governance Gate spend redeemer — authorize one vault action
// against one decision, then burn it.
pub type GateRedeemer {
  Authorize { decision_input_index: Int, target_input_index: Int }
}
