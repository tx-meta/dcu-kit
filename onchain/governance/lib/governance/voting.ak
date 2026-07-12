use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use governance/types.{
  AnyMember, CreatorOnly, Executed, GovAction, GovernanceAnchor, GovernanceDatum,
  MembershipChange, OneMemberOneVote, Open, ParamChange, Passed, Proposal,
  Rejected, ShareWeighted, SocialPayout, TreasuryMove, WriteOff,
}
use governance/validation.{output_holds_single}

// A decode of the gate's Decision datum (single constructor, matching GateDatum).
type DecisionView {
  DecisionV {
    target_id: ByteArray,
    action: GovAction,
    exec_deadline: Option<Int>,
  }
}

// The proposal UTxO sits at the dispatcher script address, so its payment
// credential IS the dispatcher policy (gov_policy) that minted its NFT.
fn own_policy_of(output: Output) -> PolicyId {
  expect Script(h) = output.address.payment_credential
  h
}

fn holds_policy(value: Value, policy: PolicyId) -> Bool {
  !list.is_empty(dict.to_pairs(assets.tokens(value, policy)))
}

// GovAction constructor tag — the opener_policy key.
pub fn action_tag(a: GovAction) -> Int {
  when a is {
    ParamChange { .. } -> 0
    SocialPayout { .. } -> 1
    WriteOff { .. } -> 2
    TreasuryMove { .. } -> 3
    MembershipChange { .. } -> 4
  }
}

// Same rule as the escrow/savings quorum socket: a VK credential is satisfied by
// a signature, a Script credential by a spent input at that script.
pub fn credential_authorized(cred: Credential, self: Transaction) -> Bool {
  when cred is {
    VerificationKey(pkh) -> list.has(self.extra_signatories, pkh)
    Script(sh) ->
      list.any(
        self.inputs,
        fn(i) { i.output.address.payment_credential == Script(sh) },
      )
  }
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
        target_id,
        action,
        voting_mode: p_vote,
        quorum,
        threshold,
        timelock_until,
        tally_yes,
        tally_no,
        votes_cast,
        status,
        ..
      }
    = pd

  // [spec 3.3.4 OpenAction]: output holds exactly the proposal NFT (name = id)
  //   under the dispatcher policy, only ADA + that policy — no stuffing/merge.
  let structure_ok = output_holds_single(prop_out, gov_policy, proposal_id)
  // [spec 3.3.4 OpenAction]: the target must be one this instance governs.
  let target_ok = list.has(governed_targets, target_id)
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

// validate_cast — CastAction
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_cast(
  anchor: GovernanceDatum,
  proposal_input_index: Int,
  proposal_output_index: Int,
  voter_index: Int,
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
  // [spec 3.3.4 CastAction]: the voter presents an eligibility token.
  expect Some(voter_in) = list.at(inputs, voter_index)
  let voter_ok = holds_policy(voter_in.output.value, member_policy)
  // [spec 3.3.4 CastAction]: weight = 1 (1m1v); share-weighted is deferred.
  let weight = vote_weight(voting_mode)

  // [spec 3.3.4 CastAction]: the continuation changes ONLY the tally by weight
  //   and votes_cast by one — every other field is byte-identical (rebuild and
  //   compare), and the proposal NFT is preserved.
  let expected: GovernanceDatum = Proposal {
    proposal_id,
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
  let structure_ok = output_holds_single(prop_out, gov_policy, proposal_id)

  and {
    is_open?,
    voter_ok?,
    transition_ok?,
    structure_ok?,
  }
}

// validate_finalize — FinalizeAction
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_finalize(
  proposal_input_index: Int,
  proposal_output_index: Int,
  self: Transaction,
) -> Bool {
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
  // [spec 3.3.4 FinalizeAction]: continuation sets status; on pass sets a
  //   timelock_until (its value is range-checked by the SDK — temporal
  //   enforcement is a documented follow-up); every other field is unchanged.
  expect Proposal { timelock_until: new_tl, .. } = new_gov
  let expected: GovernanceDatum = Proposal {
    proposal_id,
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
    new_tl != None
  } else {
    new_tl == None
  }
  let structure_ok = output_holds_single(prop_out, gov_policy, proposal_id)

  and {
    is_open?,
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
  // [spec 3.3.4 ExecuteAction]: continuation sets status = Executed; nothing else.
  let expected: GovernanceDatum = Proposal {
    proposal_id,
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
  let structure_ok = output_holds_single(prop_out, gov_policy, proposal_id)

  // [spec 3.3.4 ExecuteAction]: the decision output is locked at the gate and
  //   binds (target_id, action, exec_deadline) copied from the proposal.
  let decision_at_gate = dec_out.address.payment_credential == Script(gate_hash)
  expect InlineDatum(dd) = dec_out.datum
  expect  
      DecisionV {
        target_id: dec_target,
        action: dec_action,
        exec_deadline: dec_exec,
      }
    = dd
  let decision_bound = and {
    dec_target == target_id,
    dec_action == action,
    dec_exec == exec_deadline,
  }

  and {
    is_passed?,
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
  expect Proposal { proposal_id, status, .. } = old_d

  // [spec 3.3.4 ExpireAction]: a terminal proposal is retired — Open (undecided)
  //   or a stale Passed/Executed. Rejected is already terminal.
  let expirable = status == Open || status == Passed || status == Executed
  // [spec 3.3.4 ExpireAction]: the proposal NFT is burned (-1) this transaction.
  let burned = dict.to_pairs(assets.tokens(self.mint, gov_policy)) == [
    Pair(proposal_id, -1),
  ]

  and {
    expirable?,
    burned?,
  }
}
