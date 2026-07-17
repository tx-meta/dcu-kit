use aiken/interval
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, Transaction, ValidityRange,
}
use governance/types.{
  AnyMember, Decision, Executed, GateDatum, Generic, GovAction, GovernanceDatum,
  OneMemberOneVote, Open, ParamChange, Passed, Proposal, Rejected, Roster,
  VoterRecord,
}
use governance/validation.{decision_token_name}
use governance/voting.{
  validate_cast, validate_execute, validate_expire, validate_finalize,
  validate_open, validate_register,
}
use tests/common.{
  charter_openers, default_charter, dispatcher_address, empty_tx, gate_address,
  gov_policy, member_id, member_input, member_policy, mk_proposal, proposal_id,
  proposal_input, proposal_output, record_name, ref_at, roster_input,
  roster_output, settings_policy, target_id, target_policy, voter_record_input,
  voter_record_output, with_ada,
}

fn action() -> GovAction {
  ParamChange { field_tag: 0, new_value: 1 }
}

fn tx4(
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
  range: ValidityRange,
) -> Transaction {
  Transaction { ..empty_tx(), inputs, outputs, mint, validity_range: range }
}

// Voting window (deadline is 1000 in mk_proposal).
fn during_vote() -> ValidityRange {
  interval.before(999)
}

fn after_vote() -> ValidityRange {
  interval.between(1001, 1002)
}

fn non_member_input() -> Input {
  Input {
    output_reference: ref_at(1),
    output: Output {
      address: dispatcher_address(),
      value: assets.from_lovelace(5_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn decision_output(exec: Option<Int>) -> Output {
  decision_output_for(target_policy(), target_id(), action(), exec)
}

fn decision_output_for(
  policy: ByteArray,
  target: ByteArray,
  act: GovAction,
  exec: Option<Int>,
) -> Output {
  let d: GateDatum = Decision {
    target_policy: policy,
    target_id: target,
    action: act,
    exec_deadline: exec,
  }
  Output {
    address: gate_address(),
    value: with_ada(
      assets.from_asset(gov_policy(), decision_token_name(proposal_id()), 1),
    ),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

// ── OpenAction ───────────────────────────────────────────────────────────────

test open__accepts_valid() {
  let prop = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let tx = tx4(
    [member_input()],
    [proposal_output(prop)],
    assets.zero,
    during_vote(),
  )
  validate_open(default_charter(), 0, 0, tx)
}

test open__accepts_generic_action() {
  // The forward-compatibility arm flows through open like any frozen action:
  // governance carries it opaquely; decoding the payload is the vault's job.
  // Its opener class is keyed 5 in the charter.
  let generic = Generic { tag: 7, payload: #"d8799f00ff" }
  let prop = mk_proposal(generic, Open, 0, 0, 0, None, None)
  let tx = tx4(
    [member_input()],
    [proposal_output(prop)],
    assets.zero,
    during_vote(),
  )
  validate_open(
    charter_openers([Pair(0, AnyMember), Pair(5, AnyMember)]),
    0,
    0,
    tx,
  )
}

test open__rejects_generic_without_opener_rule() {
  // Deny-by-default: a charter with no rule for tag 5 cannot open Generic
  // actions at all.
  let generic = Generic { tag: 7, payload: #"d8799f00ff" }
  let prop = mk_proposal(generic, Open, 0, 0, 0, None, None)
  let tx = tx4(
    [member_input()],
    [proposal_output(prop)],
    assets.zero,
    during_vote(),
  )
  !validate_open(default_charter(), 0, 0, tx)
}

test open__rejects_unauthorized_opener() {
  let prop = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let tx = tx4(
    [non_member_input()],
    [proposal_output(prop)],
    assets.zero,
    during_vote(),
  )
  !validate_open(default_charter(), 0, 0, tx)
}

test open__rejects_nonzero_tally() {
  // A proposal opened with a pre-loaded tally is rejected.
  let prop = mk_proposal(action(), Open, 5, 0, 5, None, None)
  let tx = tx4(
    [member_input()],
    [proposal_output(prop)],
    assets.zero,
    during_vote(),
  )
  !validate_open(default_charter(), 0, 0, tx)
}

test open__rejects_past_deadline() {
  // The proposal's voting deadline is already in the past at open time.
  let prop = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let tx = tx4(
    [member_input()],
    [proposal_output(prop)],
    assets.zero,
    after_vote(),
  )
  !validate_open(default_charter(), 0, 0, tx)
}

test open__rejects_foreign_target() {
  // Same NAME as the governed vault, but under a different policy — the
  // (policy, name) pair is not in governed_targets.
  let prop = Proposal {
    proposal_id: proposal_id(),
    target_policy: member_policy(),
    target_id: target_id(),
    action: action(),
    voting_mode: OneMemberOneVote,
    quorum: 1,
    threshold: 5000,
    deadline: 1000,
    exec_deadline: None,
    timelock_until: None,
    tally_yes: 0,
    tally_no: 0,
    votes_cast: 0,
    status: Open,
  }
  let tx = tx4(
    [member_input()],
    [proposal_output(prop)],
    assets.zero,
    during_vote(),
  )
  !validate_open(default_charter(), 0, 0, tx)
}

test open__rejects_exec_deadline_before_deadline() {
  // An exec window that closes before voting ends can never execute.
  let prop = mk_proposal(action(), Open, 0, 0, 0, None, Some(500))
  let tx = tx4(
    [member_input()],
    [proposal_output(prop)],
    assets.zero,
    during_vote(),
  )
  !validate_open(default_charter(), 0, 0, tx)
}

// ── RegisterAction ───────────────────────────────────────────────────────────

fn record_mint() -> Value {
  assets.from_asset(gov_policy(), record_name(), 1)
}

test register__accepts_valid() {
  let tx = tx4(
    [roster_input([]), member_input()],
    [roster_output([member_id()]), voter_record_output([])],
    record_mint(),
    during_vote(),
  )
  validate_register(default_charter(), settings_policy(), 0, 0, 1, 1, tx)
}

test register__rejects_already_registered() {
  // The member is in the roster — a second registration would mint a fresh
  // empty record and re-enable double voting.
  let tx = tx4(
    [roster_input([member_id()]), member_input()],
    [roster_output([member_id(), member_id()]), voter_record_output([])],
    record_mint(),
    during_vote(),
  )
  !validate_register(default_charter(), settings_policy(), 0, 0, 1, 1, tx)
}

test register__rejects_wrong_record_name() {
  let tx = tx4(
    [roster_input([]), member_input()],
    [roster_output([member_id()]), voter_record_output([])],
    assets.from_asset(gov_policy(), "bogus", 1),
    during_vote(),
  )
  !validate_register(default_charter(), settings_policy(), 0, 0, 1, 1, tx)
}

test register__rejects_roster_not_appended() {
  let tx = tx4(
    [roster_input([]), member_input()],
    [roster_output([]), voter_record_output([])],
    record_mint(),
    during_vote(),
  )
  !validate_register(default_charter(), settings_policy(), 0, 0, 1, 1, tx)
}

test register__rejects_preloaded_voted_list() {
  // A record born with proposal ids in `voted` would block the member's votes;
  // a record born for another member is caught by the name derivation.
  let tx = tx4(
    [roster_input([]), member_input()],
    [roster_output([member_id()]), voter_record_output([proposal_id()])],
    record_mint(),
    during_vote(),
  )
  !validate_register(default_charter(), settings_policy(), 0, 0, 1, 1, tx)
}

test register__rejects_fake_roster() fail {
  // A roster-shaped UTxO without the one-shot settings NFT is not the roster.
  let fake = Input {
    output_reference: ref_at(3),
    output: Output {
      address: dispatcher_address(),
      value: assets.from_lovelace(2_000_000),
      datum: InlineDatum(roster_datum([])),
      reference_script: None,
    },
  }
  validate_register(
    default_charter(),
    settings_policy(),
    0,
    0,
    1,
    1,
    tx4(
      [fake, member_input()],
      [roster_output([member_id()]), voter_record_output([])],
      record_mint(),
      during_vote(),
    ),
  )
}

fn roster_datum(members: List<ByteArray>) -> GovernanceDatum {
  Roster { members }
}

// ── CastAction ───────────────────────────────────────────────────────────────

fn cast_tx(
  old_voted: List<ByteArray>,
  new_voted: List<ByteArray>,
  old_prop: GovernanceDatum,
  new_prop: GovernanceDatum,
  range: ValidityRange,
) -> Transaction {
  tx4(
    [proposal_input(old_prop), member_input(), voter_record_input(old_voted)],
    [proposal_output(new_prop), voter_record_output(new_voted)],
    assets.zero,
    range,
  )
}

test cast__accepts_valid_yes() {
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let new = mk_proposal(action(), Open, 1, 0, 1, None, None)
  let tx = cast_tx([], [proposal_id()], old, new, during_vote())
  validate_cast(default_charter(), 0, 0, 1, 2, 1, 99, True, tx)
}

test cast__rejects_repeat_vote() {
  // The member's record already lists this proposal — the CRIT-1 exploit.
  let old = mk_proposal(action(), Open, 1, 0, 1, None, None)
  let new = mk_proposal(action(), Open, 2, 0, 2, None, None)
  let tx = cast_tx(
    [proposal_id()],
    [proposal_id(), proposal_id()],
    old,
    new,
    during_vote(),
  )
  !validate_cast(default_charter(), 0, 0, 1, 2, 1, 99, True, tx)
}

test cast__rejects_record_not_appended() {
  // The tally moves but the record "forgets" the vote — replayable.
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let new = mk_proposal(action(), Open, 1, 0, 1, None, None)
  let tx = cast_tx([], [], old, new, during_vote())
  !validate_cast(default_charter(), 0, 0, 1, 2, 1, 99, True, tx)
}

test cast__rejects_tally_inflation() {
  // Attacker adds 2 to the tally for a single vote.
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let new = mk_proposal(action(), Open, 2, 0, 1, None, None)
  let tx = cast_tx([], [proposal_id()], old, new, during_vote())
  !validate_cast(default_charter(), 0, 0, 1, 2, 1, 99, True, tx)
}

test cast__rejects_non_member_voter() fail {
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let new = mk_proposal(action(), Open, 1, 0, 1, None, None)
  let tx = tx4(
    [proposal_input(old), non_member_input(), voter_record_input([])],
    [proposal_output(new), voter_record_output([proposal_id()])],
    assets.zero,
    during_vote(),
  )
  validate_cast(default_charter(), 0, 0, 1, 2, 1, 99, True, tx)
}

test cast__rejects_after_deadline() {
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let new = mk_proposal(action(), Open, 1, 0, 1, None, None)
  let tx = cast_tx([], [proposal_id()], old, new, after_vote())
  !validate_cast(default_charter(), 0, 0, 1, 2, 1, 99, True, tx)
}

test cast__rejects_foreign_member_record() {
  // A record bound to a different member id, presented with this member's
  // eligibility token — the derived token name does not match.
  let other: GovernanceDatum = VoterRecord { member_id: "other", voted: [] }
  let record_in = Input {
    output_reference: ref_at(2),
    output: Output {
      address: dispatcher_address(),
      value: with_ada(assets.from_asset(gov_policy(), record_name(), 1)),
      datum: InlineDatum(other),
      reference_script: None,
    },
  }
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let new = mk_proposal(action(), Open, 1, 0, 1, None, None)
  let tx = tx4(
    [proposal_input(old), member_input(), record_in],
    [proposal_output(new), voter_record_output([proposal_id()])],
    assets.zero,
    during_vote(),
  )
  !validate_cast(default_charter(), 0, 0, 1, 2, 1, 99, True, tx)
}

test cast__rejects_batched_records() {
  // Two voter records spent under one coupled cast — the second transition
  // would ride through unchecked.
  let second_record = Input {
    output_reference: ref_at(5),
    output: voter_record_output([]),
  }
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let new = mk_proposal(action(), Open, 1, 0, 1, None, None)
  let tx = tx4(
    [proposal_input(old), member_input(), voter_record_input([]), second_record],
    [proposal_output(new), voter_record_output([proposal_id()])],
    assets.zero,
    during_vote(),
  )
  !validate_cast(default_charter(), 0, 0, 1, 2, 1, 99, True, tx)
}

test cast__rejects_relocated_proposal() {
  // The tally update is correct but the proposal NFT is sent to a DIFFERENT
  // address (stake-credential swap / off-script strand) — MLabs #11.
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let new = mk_proposal(action(), Open, 1, 0, 1, None, None)
  let relocated = Output { ..proposal_output(new), address: gate_address() }
  let tx = tx4(
    [proposal_input(old), member_input(), voter_record_input([])],
    [relocated, voter_record_output([proposal_id()])],
    assets.zero,
    during_vote(),
  )
  !validate_cast(default_charter(), 0, 0, 1, 2, 1, 99, True, tx)
}

// ── FinalizeAction ───────────────────────────────────────────────────────────

test finalize__accepts_passed() {
  // quorum 1, threshold 5000: 1 yes / 0 no passes; timelock 0 pins
  // timelock_until inside the validity bounds.
  let old = mk_proposal(action(), Open, 1, 0, 1, None, None)
  let new = mk_proposal(action(), Passed, 1, 0, 1, Some(1001), None)
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new)],
    assets.zero,
    after_vote(),
  )
  validate_finalize(default_charter(), 0, 0, tx)
}

test finalize__accepts_rejected() {
  let old = mk_proposal(action(), Open, 0, 1, 1, None, None)
  let new = mk_proposal(action(), Rejected, 0, 1, 1, None, None)
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new)],
    assets.zero,
    after_vote(),
  )
  validate_finalize(default_charter(), 0, 0, tx)
}

test finalize__rejects_forced_pass() {
  // Below quorum but the continuation claims Passed.
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let new = mk_proposal(action(), Passed, 0, 0, 0, Some(1001), None)
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new)],
    assets.zero,
    after_vote(),
  )
  !validate_finalize(default_charter(), 0, 0, tx)
}

test finalize__rejects_before_deadline() {
  // Finalizing while voting is open is the quorum-capture attack.
  let old = mk_proposal(action(), Open, 1, 0, 1, None, None)
  let new = mk_proposal(action(), Passed, 1, 0, 1, Some(500), None)
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new)],
    assets.zero,
    during_vote(),
  )
  !validate_finalize(default_charter(), 0, 0, tx)
}

test finalize__rejects_forged_timelock() {
  // timelock_until far beyond finalize-time + charter.timelock.
  let old = mk_proposal(action(), Open, 1, 0, 1, None, None)
  let new = mk_proposal(action(), Passed, 1, 0, 1, Some(999_999), None)
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new)],
    assets.zero,
    after_vote(),
  )
  !validate_finalize(default_charter(), 0, 0, tx)
}

// ── ExecuteAction ────────────────────────────────────────────────────────────

fn exec_range() -> ValidityRange {
  interval.between(1002, 1003)
}

test execute__accepts_passed() {
  let old = mk_proposal(action(), Passed, 1, 0, 1, Some(1001), None)
  let new = mk_proposal(action(), Executed, 1, 0, 1, Some(1001), None)
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new), decision_output(None)],
    assets.zero,
    exec_range(),
  )
  validate_execute(default_charter(), 0, 0, 1, tx)
}

test execute__rejects_not_passed() {
  let old = mk_proposal(action(), Open, 1, 0, 1, Some(1001), None)
  let new = mk_proposal(action(), Executed, 1, 0, 1, Some(1001), None)
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new), decision_output(None)],
    assets.zero,
    exec_range(),
  )
  !validate_execute(default_charter(), 0, 0, 1, tx)
}

test execute__rejects_before_timelock() {
  // Execution before timelock_until elapses.
  let old = mk_proposal(action(), Passed, 1, 0, 1, Some(5000), None)
  let new = mk_proposal(action(), Executed, 1, 0, 1, Some(5000), None)
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new), decision_output(None)],
    assets.zero,
    exec_range(),
  )
  !validate_execute(default_charter(), 0, 0, 1, tx)
}

test execute__rejects_past_exec_deadline() {
  let old = mk_proposal(action(), Passed, 1, 0, 1, Some(1001), Some(1500))
  let new = mk_proposal(action(), Executed, 1, 0, 1, Some(1001), Some(1500))
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new), decision_output(Some(1500))],
    assets.zero,
    interval.between(1600, 1601),
  )
  !validate_execute(default_charter(), 0, 0, 1, tx)
}

test execute__rejects_decision_wrong_policy() {
  // The decision claims a target under a DIFFERENT policy than the proposal's.
  let old = mk_proposal(action(), Passed, 1, 0, 1, Some(1001), None)
  let new = mk_proposal(action(), Executed, 1, 0, 1, Some(1001), None)
  let bad = decision_output_for(member_policy(), target_id(), action(), None)
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new), bad],
    assets.zero,
    exec_range(),
  )
  !validate_execute(default_charter(), 0, 0, 1, tx)
}

test execute__rejects_decision_wrong_action() {
  let old = mk_proposal(action(), Passed, 1, 0, 1, Some(1001), None)
  let new = mk_proposal(action(), Executed, 1, 0, 1, Some(1001), None)
  let bad = decision_output_for(
    target_policy(),
    target_id(),
    ParamChange { field_tag: 9, new_value: 9 },
    None,
  )
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new), bad],
    assets.zero,
    exec_range(),
  )
  !validate_execute(default_charter(), 0, 0, 1, tx)
}

test execute__rejects_wrong_decision_token_name() {
  // The decision output carries a token of an ARBITRARY name (not the derived
  // decision_token_name) — an unpinned mint, MLabs #2.
  let old = mk_proposal(action(), Passed, 1, 0, 1, Some(1001), None)
  let new = mk_proposal(action(), Executed, 1, 0, 1, Some(1001), None)
  let bad_decision = Output {
    address: gate_address(),
    value: with_ada(assets.from_asset(gov_policy(), "wrongname", 1)),
    datum: InlineDatum(
      Decision {
        target_policy: target_policy(),
        target_id: target_id(),
        action: action(),
        exec_deadline: None,
      },
    ),
    reference_script: None,
  }
  let tx = tx4(
    [proposal_input(old)],
    [proposal_output(new), bad_decision],
    assets.zero,
    exec_range(),
  )
  !validate_execute(default_charter(), 0, 0, 1, tx)
}

// ── ExpireAction ─────────────────────────────────────────────────────────────

fn burn() -> Value {
  assets.from_asset(gov_policy(), proposal_id(), -1)
}

test expire__accepts_open_after_deadline() {
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let tx = tx4([proposal_input(old)], [], burn(), interval.after(1001))
  validate_expire(0, tx)
}

test expire__rejects_open_before_deadline() {
  // Burning a LIVE proposal is the permissionless-expire DoS.
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let tx = tx4([proposal_input(old)], [], burn(), during_vote())
  !validate_expire(0, tx)
}

test expire__accepts_rejected_anytime() {
  let old = mk_proposal(action(), Rejected, 0, 1, 1, None, None)
  let tx = tx4([proposal_input(old)], [], burn(), during_vote())
  validate_expire(0, tx)
}

test expire__accepts_executed_anytime() {
  let old = mk_proposal(action(), Executed, 1, 0, 1, Some(1001), None)
  let tx = tx4([proposal_input(old)], [], burn(), during_vote())
  validate_expire(0, tx)
}

test expire__rejects_passed_without_exec_deadline() {
  // A Passed proposal with no exec window is never expirable.
  let old = mk_proposal(action(), Passed, 1, 0, 1, Some(1001), None)
  let tx = tx4([proposal_input(old)], [], burn(), interval.after(9999))
  !validate_expire(0, tx)
}

test expire__accepts_passed_after_exec_deadline() {
  let old = mk_proposal(action(), Passed, 1, 0, 1, Some(1001), Some(1500))
  let tx = tx4([proposal_input(old)], [], burn(), interval.after(1501))
  validate_expire(0, tx)
}

test expire__rejects_no_burn() {
  let old = mk_proposal(action(), Open, 0, 0, 0, None, None)
  let tx = tx4([proposal_input(old)], [], assets.zero, interval.after(1001))
  !validate_expire(0, tx)
}
