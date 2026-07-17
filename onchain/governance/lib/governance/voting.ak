use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Transaction}
use governance/types.{
  AnyMember, CreatorOnly, Executed, Generic, GovAction, GovernanceAnchor,
  GovernanceDatum, MembershipChange, OneMemberOneVote, Open, ParamChange, Passed,
  Proposal, Rejected, Roster, ShareWeighted, SocialPayout, TreasuryMove,
  VoterRecord, WriteOff,
}
use governance/validation.{
  credential_authorized, decision_token_name, holds_policy, is_voter_record,
  mints_exactly_one, output_holds_single, own_policy_of, roster_name,
  spent_of_kind, voter_record_name,
}

// A decode of the gate's Decision datum (single constructor, matching GateDatum).
type DecisionView {
  DecisionV {
    target_policy: ByteArray,
    target_id: ByteArray,
    action: GovAction,
    exec_deadline: Option<Int>,
  }
}

// GovAction constructor tag — the opener_policy key.
pub fn action_tag(a: GovAction) -> Int {
  when a is {
    ParamChange { .. } -> 0
    SocialPayout { .. } -> 1
    WriteOff { .. } -> 2
    TreasuryMove { .. } -> 3
    MembershipChange { .. } -> 4
    // All Generic actions share ONE opener class (key 5) regardless of inner
    // tag — the inner tag is vault-decode vocabulary, not an opener key.
    Generic { .. } -> 5
  }
}

// ── temporal helpers ─────────────────────────────────────────────────────────
// All lifecycle gating runs on the tx validity interval: the ledger guarantees
// the tx executes inside it, so "entirely before t" proves now < t and
// "entirely after t" proves now > t.

fn before(self: Transaction, t: Int) -> Bool {
  interval.is_entirely_before(self.validity_range, t)
}

fn after(self: Transaction, t: Int) -> Bool {
  interval.is_entirely_after(self.validity_range, t)
}

// The single member-eligibility token in the voter's input — its name is the
// member's identity. A wallet input carrying two eligibility tokens fails the
// expect (the SDK isolates the token UTxO).
fn member_id_of(voter_in: Input, member_policy: ByteArray) -> ByteArray {
  expect [Pair(member_id, _)] = dict.to_pairs(
    assets.tokens(voter_in.output.value, member_policy),
  )
  member_id
}

// validate_open — OpenAction
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_open(
  anchor: GovernanceDatum,
  proposal_output_index: Int,
  opener_index: Int,
  self: Transaction,
) -> Bool {
  expect  
      GovernanceAnchor {
        member_policy,
        governed_targets,
        voting_mode,
        default_quorum,
        default_threshold,
        opener_policy,
        creator,
        ..
      }
    = anchor
  let Transaction { inputs, outputs, .. } = self
  expect Some(prop_out) = list.at(outputs, proposal_output_index)
  let gov_policy = own_policy_of(prop_out)
  expect InlineDatum(pd) = prop_out.datum
  expect  
      Proposal {
        proposal_id,
        target_policy,
        target_id,
        action,
        voting_mode: p_vote,
        quorum,
        threshold,
        deadline,
        exec_deadline,
        timelock_until,
        tally_yes,
        tally_no,
        votes_cast,
        status,
      }
    = pd

  // [spec 3.3.4 OpenAction]: output holds exactly the proposal NFT (name = id)
  //   under the dispatcher policy, only ADA + that policy — no stuffing/merge.
  let structure_ok = output_holds_single(prop_out, gov_policy, proposal_id)
  // [spec 3.3.4 OpenAction]: the (policy, name) target pair must be one this
  //   instance governs — both halves bind (a name alone is forgeable).
  let target_ok = list.has(governed_targets, Pair(target_policy, target_id))
  // [spec 3.3.4 OpenAction]: the charter's rules are frozen into the proposal.
  let rules_frozen = and {
    p_vote == voting_mode,
    quorum == default_quorum,
    threshold == default_threshold,
  }
  // [spec 3.3.4 OpenAction]: a fresh Open proposal — zero tallies, no timelock.
  let fresh = and {
    status == Open,
    tally_yes == 0,
    tally_no == 0,
    votes_cast == 0,
    timelock_until == None,
  }
  // [spec 3.3.4 OpenAction temporal]: the voting deadline must lie in the
  //   future, and an exec_deadline (when set) must leave room to execute.
  let deadline_ok = and {
    before(self, deadline),
    when exec_deadline is {
      Some(ed) -> ed > deadline
      None -> True
    },
  }
  // [spec 3.3.4 OpenAction]: the opener is authorized for this action class.
  let opener_ok = when
    list.find(opener_policy, fn(p) { p.1st == action_tag(action) })
  is {
    Some(Pair(_, AnyMember)) -> {
      expect Some(opener_in) = list.at(inputs, opener_index)
      holds_policy(opener_in.output.value, member_policy)
    }
    Some(Pair(_, CreatorOnly)) -> credential_authorized(creator, self)
    None -> False
  }

  and {
    structure_ok?,
    target_ok?,
    rules_frozen?,
    fresh?,
    deadline_ok?,
    opener_ok?,
  }
}

// vote_weight — 1 for one-member-one-vote. Share-weighted on-chain enforcement
// is a documented follow-up: it needs a stable cross-family decode of the
// savings account datum (the reference-read composition contract), which no
// test yet exercises — shipping it untested would be a security risk. A charter
// may still be set to ShareWeighted, but a cast under it fails until implemented.
fn vote_weight(voting_mode) -> Int {
  when voting_mode is {
    OneMemberOneVote -> 1
    ShareWeighted { .. } ->
      fail @"share-weighted voting on-chain enforcement is deferred; use one-member-one-vote"
  }
}

// validate_register — RegisterAction
// ─────────────────────────────────────────────────────────────────────────────
// One-shot voter-record creation. The roster (ever-registered set) is what makes
// it one-shot: a member appears in it exactly once, so exactly one record with
// their derived token name can ever be minted — the precondition the cast-time
// nullifier rests on.
pub fn validate_register(
  anchor: GovernanceDatum,
  settings_policy: ByteArray,
  roster_input_index: Int,
  roster_output_index: Int,
  record_output_index: Int,
  member_index: Int,
  self: Transaction,
) -> Bool {
  expect GovernanceAnchor { member_policy, .. } = anchor
  let Transaction { inputs, outputs, mint, .. } = self

  // [spec 3.3.4 RegisterAction]: the spent roster is the genuine one — it holds
  //   the one-shot roster NFT minted with the anchor.
  expect Some(roster_in) = list.at(inputs, roster_input_index)
  let roster_genuine = assets.quantity_of(
    roster_in.output.value,
    settings_policy,
    roster_name,
  ) == 1
  let gov_policy = own_policy_of(roster_in.output)
  expect InlineDatum(rd) = roster_in.output.datum
  expect roster_datum: GovernanceDatum = rd
  expect Roster { members } = roster_datum

  // [spec 3.3.4 RegisterAction]: the registrant presents their eligibility
  //   token; its name is the member identity being registered.
  expect Some(member_in) = list.at(inputs, member_index)
  let member_id = member_id_of(member_in, member_policy)

  // [spec 3.3.4 RegisterAction]: one registration per member, ever — the
  //   double-vote nullifier's uniqueness root.
  let not_registered = !list.has(members, member_id)

  // [spec 3.3.4 RegisterAction]: roster continuation — same address, roster NFT
  //   preserved, member appended, no value skimmed.
  expect Some(roster_out) = list.at(outputs, roster_output_index)
  expect InlineDatum(nrd) = roster_out.datum
  expect new_roster: GovernanceDatum = nrd
  let roster_ok = and {
    output_holds_single(roster_out, settings_policy, roster_name),
    roster_out.address == roster_in.output.address,
    new_roster == Roster { members: [member_id, ..members] },
    assets.lovelace_of(roster_out.value) >= assets.lovelace_of(
      roster_in.output.value,
    ),
  }

  // [spec 3.3.4 RegisterAction]: exactly the member's derived record token is
  //   minted, and the record UTxO starts at the dispatcher with an EMPTY voted
  //   list bound to this member.
  let record_name = voter_record_name(member_id)
  let minted = mints_exactly_one(mint, gov_policy, record_name)
  expect Some(record_out) = list.at(outputs, record_output_index)
  expect InlineDatum(rcd) = record_out.datum
  expect new_record: GovernanceDatum = rcd
  let record_ok = and {
    output_holds_single(record_out, gov_policy, record_name),
    record_out.address == roster_in.output.address,
    new_record == VoterRecord { member_id, voted: [] },
  }

  and {
    roster_genuine?,
    not_registered?,
    roster_ok?,
    minted?,
    record_ok?,
  }
}

// validate_cast — CastAction
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_cast(
  anchor: GovernanceDatum,
  proposal_input_index: Int,
  proposal_output_index: Int,
  voter_index: Int,
  record_input_index: Int,
  record_output_index: Int,
  _share_ref_index: Int,
  approve: Bool,
  self: Transaction,
) -> Bool {
  expect GovernanceAnchor { member_policy, voting_mode, .. } = anchor
  let Transaction { inputs, outputs, .. } = self
  expect Some(prop_in) = list.at(inputs, proposal_input_index)
  expect Some(prop_out) = list.at(outputs, proposal_output_index)
  let gov_policy = own_policy_of(prop_in.output)
  expect InlineDatum(old_d) = prop_in.output.datum
  expect InlineDatum(new_data) = prop_out.datum
  expect new_gov: GovernanceDatum = new_data
  expect  
      Proposal {
        proposal_id,
        target_policy,
        target_id,
        action,
        voting_mode: vm,
        quorum,
        threshold,
        deadline,
        exec_deadline,
        timelock_until,
        tally_yes,
        tally_no,
        votes_cast,
        status,
      }
    = old_d

  // [spec 3.3.4 CastAction]: only an Open proposal accepts votes.
  let is_open = status == Open
  // [spec 3.3.4 CastAction temporal]: votes land strictly before the deadline.
  let in_window = before(self, deadline)
  // [spec 3.3.4 CastAction]: the voter presents an eligibility token — its name
  //   is the member identity.
  expect Some(voter_in) = list.at(inputs, voter_index)
  let voter_ok = holds_policy(voter_in.output.value, member_policy)
  let member_id = member_id_of(voter_in, member_policy)
  // [spec 3.3.4 CastAction]: weight = 1 (1m1v); share-weighted is deferred.
  let weight = vote_weight(voting_mode)

  // [spec 3.3.4 CastAction nullifier]: the member's voter record is SPENT. The
  //   record token name is derived from the member id (one record per member,
  //   rooted in the roster), the record must not already contain this proposal,
  //   and the continuation appends it. Voting twice therefore needs either a
  //   UTxO the ledger already consumed or a successor datum that already lists
  //   this proposal — both impossible.
  let record_name = voter_record_name(member_id)
  expect Some(record_in) = list.at(inputs, record_input_index)
  expect InlineDatum(rd) = record_in.output.datum
  expect record_datum: GovernanceDatum = rd
  expect VoterRecord { member_id: rec_member, voted } = record_datum
  let record_in_ok = and {
    record_in.output.address.payment_credential == Script(gov_policy),
    dict.to_pairs(assets.tokens(record_in.output.value, gov_policy)) == [
      Pair(record_name, 1),
    ],
    rec_member == member_id,
    !list.has(voted, proposal_id),
  }
  expect Some(record_out) = list.at(outputs, record_output_index)
  expect InlineDatum(nrd) = record_out.datum
  expect new_record: GovernanceDatum = nrd
  let record_out_ok = and {
    output_holds_single(record_out, gov_policy, record_name),
    record_out.address == record_in.output.address,
    new_record == VoterRecord { member_id, voted: [proposal_id, ..voted] },
    assets.lovelace_of(record_out.value) >= assets.lovelace_of(
      record_in.output.value,
    ),
  }
  // [security]: exactly ONE voter record is spent — the single coupled cast
  //   validates one record transition; a second would ride through unchecked.
  let single_record = spent_of_kind(inputs, gov_policy, is_voter_record) == 1

  // [spec 3.3.4 CastAction]: the continuation changes ONLY the tally by weight
  //   and votes_cast by one — every other field is byte-identical (rebuild and
  //   compare), and the proposal NFT is preserved.
  let expected: GovernanceDatum = Proposal {
    proposal_id,
    target_policy,
    target_id,
    action,
    voting_mode: vm,
    quorum,
    threshold,
    deadline,
    exec_deadline,
    timelock_until,
    tally_yes: if approve {
      tally_yes + weight
    } else {
      tally_yes
    },
    tally_no: if approve {
      tally_no
    } else {
      tally_no + weight
    },
    votes_cast: votes_cast + 1,
    status: Open,
  }
  let transition_ok = new_gov == expected
  // [security]: the proposal NFT stays at its EXACT address (full address, not
  //   just the payment credential) — pinning only the script hash would leave
  //   the stake credential free, letting a voter redirect staking rewards on
  //   the proposal's ADA (MLabs #11) or strand the proposal off-script.
  let structure_ok = and {
    output_holds_single(prop_out, gov_policy, proposal_id),
    prop_out.address == prop_in.output.address,
  }

  and {
    is_open?,
    in_window?,
    voter_ok?,
    record_in_ok?,
    record_out_ok?,
    single_record?,
    transition_ok?,
    structure_ok?,
  }
}

// validate_finalize — FinalizeAction
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_finalize(
  anchor: GovernanceDatum,
  proposal_input_index: Int,
  proposal_output_index: Int,
  self: Transaction,
) -> Bool {
  expect GovernanceAnchor { timelock, .. } = anchor
  let Transaction { inputs, outputs, .. } = self
  expect Some(prop_in) = list.at(inputs, proposal_input_index)
  expect Some(prop_out) = list.at(outputs, proposal_output_index)
  let gov_policy = own_policy_of(prop_in.output)
  expect InlineDatum(old_d) = prop_in.output.datum
  expect InlineDatum(new_data) = prop_out.datum
  expect new_gov: GovernanceDatum = new_data
  expect  
      Proposal {
        proposal_id,
        target_policy,
        target_id,
        action,
        voting_mode: vm,
        quorum,
        threshold,
        deadline,
        exec_deadline,
        tally_yes,
        tally_no,
        votes_cast,
        status,
        ..
      }
    = old_d

  // [spec 3.3.4 FinalizeAction]: only an Open proposal can be decided.
  let is_open = status == Open
  // [spec 3.3.4 FinalizeAction temporal]: no decision before voting closes —
  //   an early finalize under a small quorum is a capture attack.
  let voting_closed = after(self, deadline)
  // [spec 3.3.4 FinalizeAction]: decision by the FROZEN quorum + threshold over
  //   votes cast — quorum met AND yes-share >= threshold (basis points).
  let cast = tally_yes + tally_no
  let passed = and {
    cast >= quorum,
    tally_yes * 10000 >= threshold * cast,
  }
  let new_status = if passed {
    Passed
  } else {
    Rejected
  }
  // [spec 3.3.4 FinalizeAction]: continuation sets status; on pass sets
  //   timelock_until = finalize-time + charter.timelock, pinned by the tx
  //   validity bounds (both finite); every other field is unchanged.
  expect Proposal { timelock_until: new_tl, .. } = new_gov
  let expected: GovernanceDatum = Proposal {
    proposal_id,
    target_policy,
    target_id,
    action,
    voting_mode: vm,
    quorum,
    threshold,
    deadline,
    exec_deadline,
    timelock_until: new_tl,
    tally_yes,
    tally_no,
    votes_cast,
    status: new_status,
  }
  let transition_ok = new_gov == expected
  let timelock_ok = if passed {
    expect Some(tl) = new_tl
    expect Finite(lo) = self.validity_range.lower_bound.bound_type
    expect Finite(hi) = self.validity_range.upper_bound.bound_type
    tl >= lo + timelock && tl <= hi + timelock
  } else {
    new_tl == None
  }
  // [security]: NFT stays at its exact address (see validate_cast — MLabs #11).
  let structure_ok = and {
    output_holds_single(prop_out, gov_policy, proposal_id),
    prop_out.address == prop_in.output.address,
  }

  and {
    is_open?,
    voting_closed?,
    transition_ok?,
    timelock_ok?,
    structure_ok?,
  }
}

// validate_execute — ExecuteAction
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_execute(
  anchor: GovernanceDatum,
  proposal_input_index: Int,
  proposal_output_index: Int,
  decision_output_index: Int,
  self: Transaction,
) -> Bool {
  expect GovernanceAnchor { gate_hash, .. } = anchor
  let Transaction { inputs, outputs, .. } = self
  expect Some(prop_in) = list.at(inputs, proposal_input_index)
  expect Some(prop_out) = list.at(outputs, proposal_output_index)
  expect Some(dec_out) = list.at(outputs, decision_output_index)
  let gov_policy = own_policy_of(prop_in.output)
  expect InlineDatum(old_d) = prop_in.output.datum
  expect InlineDatum(new_data) = prop_out.datum
  expect new_gov: GovernanceDatum = new_data
  expect  
      Proposal {
        proposal_id,
        target_policy,
        target_id,
        action,
        voting_mode: vm,
        quorum,
        threshold,
        deadline,
        exec_deadline,
        timelock_until,
        tally_yes,
        tally_no,
        votes_cast,
        status,
      }
    = old_d

  // [spec 3.3.4 ExecuteAction]: only a Passed proposal can be executed.
  let is_passed = status == Passed
  // [spec 3.3.4 ExecuteAction temporal]: the timelock set at finalize must have
  //   elapsed, and execution must land before the exec_deadline when one is set.
  expect Some(tl) = timelock_until
  let timelock_elapsed = after(self, tl)
  let before_exec_deadline = when exec_deadline is {
    Some(ed) -> before(self, ed)
    None -> True
  }
  // [spec 3.3.4 ExecuteAction]: continuation sets status = Executed; nothing else.
  let expected: GovernanceDatum = Proposal {
    proposal_id,
    target_policy,
    target_id,
    action,
    voting_mode: vm,
    quorum,
    threshold,
    deadline,
    exec_deadline,
    timelock_until,
    tally_yes,
    tally_no,
    votes_cast,
    status: Executed,
  }
  let transition_ok = new_gov == expected
  // [security]: NFT stays at its exact address (see validate_cast — MLabs #11).
  let structure_ok = and {
    output_holds_single(prop_out, gov_policy, proposal_id),
    prop_out.address == prop_in.output.address,
  }

  // [spec 3.3.4 ExecuteAction]: the decision output is locked at the gate,
  //   holds EXACTLY the derived-name decision token under gov_policy (nothing
  //   else — an unpinned mint would let an attacker mint an arbitrary-name
  //   token, MLabs #2), and binds (target_policy, target_id, action,
  //   exec_deadline) copied from the proposal — the full replay-safety tuple.
  let decision_name = decision_token_name(proposal_id)
  let decision_at_gate = and {
    dec_out.address.payment_credential == Script(gate_hash),
    output_holds_single(dec_out, gov_policy, decision_name),
  }
  expect InlineDatum(dd) = dec_out.datum
  expect  
      DecisionV {
        target_policy: dec_policy,
        target_id: dec_target,
        action: dec_action,
        exec_deadline: dec_exec,
      }
    = dd
  let decision_bound = and {
    dec_policy == target_policy,
    dec_target == target_id,
    dec_action == action,
    dec_exec == exec_deadline,
  }

  and {
    is_passed?,
    timelock_elapsed?,
    before_exec_deadline?,
    transition_ok?,
    structure_ok?,
    decision_at_gate?,
    decision_bound?,
  }
}

// validate_expire — ExpireAction
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_expire(proposal_input_index: Int, self: Transaction) -> Bool {
  let Transaction { inputs, .. } = self
  expect Some(prop_in) = list.at(inputs, proposal_input_index)
  let gov_policy = own_policy_of(prop_in.output)
  expect InlineDatum(old_d) = prop_in.output.datum
  expect Proposal { proposal_id, deadline, exec_deadline, status, .. } = old_d

  // [spec 3.3.4 ExpireAction temporal]: retiring stays permissionless (garbage
  //   collection with the min-ADA as the incentive) but can never cut a LIVE
  //   proposal short: an Open proposal only after its voting deadline, a Passed
  //   one only after its exec_deadline lapses (no exec_deadline = not
  //   expirable), and terminal Executed/Rejected any time.
  let expirable = when status is {
    Open -> after(self, deadline)
    Passed ->
      when exec_deadline is {
        Some(ed) -> after(self, ed)
        None -> False
      }
    Executed -> True
    Rejected -> True
    _ -> False
  }
  // [spec 3.3.4 ExpireAction]: the proposal NFT is burned (-1) this transaction.
  let burned = dict.to_pairs(assets.tokens(self.mint, gov_policy)) == [
    Pair(proposal_id, -1),
  ]

  and {
    expirable?,
    burned?,
  }
}
