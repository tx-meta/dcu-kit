use cardano/address.{Address}
use cardano/address as addr
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use cardano/transaction as tx
use governance/types.{
  AnyMember, GovAction, GovernanceAnchor, GovernanceDatum, OneMemberOneVote,
  Proposal, ProposalStatus, VotingMode,
}
use governance/validation.{anchor_name}

pub fn settings_policy() -> PolicyId {
  #"5a715a715a715a715a715a715a715a715a715a715a715a715a715a71"
}

pub fn gov_policy() -> PolicyId {
  #"90b190b190b190b190b190b190b190b190b190b190b190b190b190b1"
}

pub fn voting_hash() -> ByteArray {
  #"c0c1c2c3c4c5c6c7c8c9cacbcccdcecfc0c1c2c3c4c5c6c7c8c9cacb"
}

pub fn gate_hash() -> ByteArray {
  #"dadadadadadadadadadadadadadadadadadadadadadadadadadadada"
}

pub fn creator_pkh() -> ByteArray {
  #"1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d"
}

pub fn member_policy() -> PolicyId {
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
}

pub fn target_id() -> ByteArray {
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}

pub fn seed_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
    output_index: 0,
  }
}

pub fn dispatcher_address() -> Address {
  addr.from_script(gov_policy())
}

pub fn gate_address() -> Address {
  addr.from_script(gate_hash())
}

// A minimal but well-formed charter for tests, with variable published hashes.
pub fn charter_hashes(
  vote: VotingMode,
  quorum: Int,
  threshold: Int,
  voting: ByteArray,
  gate: ByteArray,
) -> GovernanceDatum {
  GovernanceAnchor {
    title: "Chama",
    member_policy: member_policy(),
    governed_targets: [target_id()],
    voting_mode: vote,
    default_quorum: quorum,
    default_threshold: threshold,
    opener_policy: [Pair(0, AnyMember)],
    timelock: 0,
    creator: addr.VerificationKey(creator_pkh()),
    voting_stake_hash: voting,
    gate_hash: gate,
  }
}

pub fn charter(vote: VotingMode, quorum: Int, threshold: Int) -> GovernanceDatum {
  charter_hashes(vote, quorum, threshold, voting_hash(), gate_hash())
}

pub fn default_charter() -> GovernanceDatum {
  charter(OneMemberOneVote, 1, 5000)
}

// The anchor UTxO output (holds the settings NFT + inline charter datum).
pub fn anchor_output(d: GovernanceDatum) -> Output {
  Output {
    address: dispatcher_address(),
    value: with_ada(assets.from_asset(settings_policy(), anchor_name, 1)),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

pub fn anchor_input(d: GovernanceDatum) -> Input {
  Input { output_reference: seed_ref(), output: anchor_output(d) }
}

// A proposal datum with sensible defaults; override via record update at call sites.
pub fn proposal(
  id: ByteArray,
  action: GovAction,
  status: ProposalStatus,
) -> GovernanceDatum {
  Proposal {
    proposal_id: id,
    target_id: target_id(),
    action,
    voting_mode: OneMemberOneVote,
    quorum: 1,
    threshold: 5000,
    deadline: 1000,
    exec_deadline: None,
    timelock_until: None,
    tally_yes: 0,
    tally_no: 0,
    votes_cast: 0,
    status,
  }
}

// A proposal datum with the fixed test id/target and given action, status, and
// tallies (deadline 1000, quorum 1, threshold 5000, 1m1v).
pub fn mk_proposal(
  action: GovAction,
  status: ProposalStatus,
  yes: Int,
  no: Int,
  cast: Int,
  timelock_until: Option<Int>,
) -> GovernanceDatum {
  Proposal {
    proposal_id: proposal_id(),
    target_id: target_id(),
    action,
    voting_mode: OneMemberOneVote,
    quorum: 1,
    threshold: 5000,
    deadline: 1000,
    exec_deadline: None,
    timelock_until,
    tally_yes: yes,
    tally_no: no,
    votes_cast: cast,
    status,
  }
}

pub fn with_ada(v: Value) -> Value {
  assets.merge(assets.from_lovelace(2_000_000), v)
}

pub fn empty_tx() -> Transaction {
  tx.placeholder
}

// ── Voting test builders ─────────────────────────────────────────────────────

pub fn proposal_id() -> ByteArray {
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

pub fn ref_at(ix: Int) -> OutputReference {
  OutputReference { transaction_id: proposal_id(), output_index: ix }
}

// A proposal output at the dispatcher address holding the proposal NFT + datum.
pub fn proposal_output(d: GovernanceDatum) -> Output {
  Output {
    address: dispatcher_address(),
    value: with_ada(assets.from_asset(gov_policy(), proposal_id(), 1)),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

pub fn proposal_input(d: GovernanceDatum) -> Input {
  Input { output_reference: ref_at(0), output: proposal_output(d) }
}

// A wallet input holding a membership token (eligibility).
pub fn member_input() -> Input {
  Input {
    output_reference: ref_at(1),
    output: Output {
      address: addr.from_verification_key(creator_pkh()),
      value: with_ada(assets.from_asset(member_policy(), "member", 1)),
      datum: NoDatum,
      reference_script: None,
    },
  }
}
