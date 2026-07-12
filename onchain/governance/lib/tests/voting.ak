use cardano/assets.{Value}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, Transaction}
use governance/types.{
  Decision, Executed, GateDatum, GovAction, Open, ParamChange, Passed,
}
use governance/voting.{
  validate_cast, validate_execute, validate_expire, validate_finalize,
  validate_open,
}
use tests/common.{
  default_charter, dispatcher_address, empty_tx, gate_address, gov_policy,
  member_input, mk_proposal, proposal_id, proposal_input, proposal_output,
  ref_at, target_id,
}

fn action() -> GovAction {
  ParamChange { field_tag: 0, new_value: 1 }
}

fn tx3(inputs: List<Input>, outputs: List<Output>, mint: Value) -> Transaction {
  Transaction { ..empty_tx(), inputs, outputs, mint }
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
  let d: GateDatum = Decision {
    target_id: target_id(),
    action: action(),
    exec_deadline: exec,
  }
  Output {
    address: gate_address(),
    value: assets.from_lovelace(2_000_000),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

// ── OpenAction ───────────────────────────────────────────────────────────────

test open__accepts_valid() {
  let prop = mk_proposal(action(), Open, 0, 0, 0, None)
  let tx = tx3([member_input()], [proposal_output(prop)], assets.zero)
  validate_open(default_charter(), 0, 0, tx)
}

test open__rejects_unauthorized_opener() {
  let prop = mk_proposal(action(), Open, 0, 0, 0, None)
  let tx = tx3([non_member_input()], [proposal_output(prop)], assets.zero)
  !validate_open(default_charter(), 0, 0, tx)
}

test open__rejects_nonzero_tally() {
  // A proposal opened with a pre-loaded tally is rejected.
  let prop = mk_proposal(action(), Open, 5, 0, 5, None)
  let tx = tx3([member_input()], [proposal_output(prop)], assets.zero)
  !validate_open(default_charter(), 0, 0, tx)
}

// ── CastAction ───────────────────────────────────────────────────────────────

test cast__accepts_valid_yes() {
  let old = mk_proposal(action(), Open, 0, 0, 0, None)
  let new = mk_proposal(action(), Open, 1, 0, 1, None)
  let tx = tx3(
    [proposal_input(old), member_input()],
    [proposal_output(new)],
    assets.zero,
  )
  validate_cast(default_charter(), 0, 0, 1, 99, True, tx)
}

test cast__rejects_tally_inflation() {
  // Attacker adds 2 to the tally for a single vote.
  let old = mk_proposal(action(), Open, 0, 0, 0, None)
  let new = mk_proposal(action(), Open, 2, 0, 1, None)
  let tx = tx3(
    [proposal_input(old), member_input()],
    [proposal_output(new)],
    assets.zero,
  )
  !validate_cast(default_charter(), 0, 0, 1, 99, True, tx)
}

test cast__rejects_non_member_voter() {
  let old = mk_proposal(action(), Open, 0, 0, 0, None)
  let new = mk_proposal(action(), Open, 1, 0, 1, None)
  let tx = tx3(
    [proposal_input(old), non_member_input()],
    [proposal_output(new)],
    assets.zero,
  )
  !validate_cast(default_charter(), 0, 0, 1, 99, True, tx)
}

// ── FinalizeAction ───────────────────────────────────────────────────────────

test finalize__accepts_passed() {
  // quorum 1, threshold 5000: 1 yes / 0 no passes.
  let old = mk_proposal(action(), Open, 1, 0, 1, None)
  let new = mk_proposal(action(), Passed, 1, 0, 1, Some(0))
  let tx = tx3([proposal_input(old)], [proposal_output(new)], assets.zero)
  validate_finalize(0, 0, tx)
}

test finalize__rejects_forced_pass() {
  // Below quorum but the continuation claims Passed.
  let old = mk_proposal(action(), Open, 0, 0, 0, None)
  let new = mk_proposal(action(), Passed, 0, 0, 0, Some(0))
  let tx = tx3([proposal_input(old)], [proposal_output(new)], assets.zero)
  !validate_finalize(0, 0, tx)
}

// ── ExecuteAction ────────────────────────────────────────────────────────────

test execute__accepts_passed() {
  let old = mk_proposal(action(), Passed, 1, 0, 1, Some(0))
  let new = mk_proposal(action(), Executed, 1, 0, 1, Some(0))
  let tx = tx3(
    [proposal_input(old)],
    [proposal_output(new), decision_output(None)],
    assets.zero,
  )
  validate_execute(default_charter(), 0, 0, 1, tx)
}

test execute__rejects_not_passed() {
  let old = mk_proposal(action(), Open, 1, 0, 1, None)
  let new = mk_proposal(action(), Executed, 1, 0, 1, None)
  let tx = tx3(
    [proposal_input(old)],
    [proposal_output(new), decision_output(None)],
    assets.zero,
  )
  !validate_execute(default_charter(), 0, 0, 1, tx)
}

// ── ExpireAction ─────────────────────────────────────────────────────────────

test expire__accepts_burn() {
  let old = mk_proposal(action(), Open, 0, 0, 0, None)
  let burn = assets.from_asset(gov_policy(), proposal_id(), -1)
  let tx = tx3([proposal_input(old)], [], burn)
  validate_expire(0, tx)
}

test expire__rejects_no_burn() {
  let old = mk_proposal(action(), Open, 0, 0, 0, None)
  let tx = tx3([proposal_input(old)], [], assets.zero)
  !validate_expire(0, tx)
}
