//// Dispatcher ↔ family stake-validator coupling (the pin + tag rules).
//// Spec: 2026-07-04-treasury-split-design.md section 5.

use aiken/collection/list
use aiken/fuzz
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{
  Input, OutputReference, Redeemer, ScriptPurpose, Spend, Withdraw,
}
use dcu/dispatch.{
  action_covers_own_input, action_tag_is, action_tag_of, covered_inputs_of,
}
use dcu/treasury_actions.{
  CancelAction, CreateAction, ExitAction, JoinAction, ProposeAction,
}
use tests/common

// ─── Shared test helpers ──────────────────────────────────────────────────────

fn family_hash() -> assets.PolicyId {
  common.test_hash_05()
}

fn input_ref(index: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"9999999999999999999999999999999999999999999999999999999999999999",
    output_index: index,
  }
}

fn test_inputs(count: Int) -> List<Input> {
  when count is {
    0 -> []
    _ ->
      list.concat(
        test_inputs(count - 1),
        [common.test_input(input_ref(count - 1), common.placeholder_output)],
      )
  }
}

fn cancel_action_data(covered: List<Int>) -> Redeemer {
  let action: Data = CancelAction { covered_inputs: covered }
  action
}

fn family_redeemers(rdata: Redeemer) -> Pairs<ScriptPurpose, Redeemer> {
  [Pair(Withdraw(Script(family_hash())), rdata)]
}

// ─── covered_inputs_of / action_tag_of ────────────────────────────────────────

// The first field of every family action is covered_inputs — decoded field-blind.
test covered_inputs_of__decodes_first_field() {
  let action: Data = ExitAction {
    covered_inputs: [3, 7],
    group_ref_input_index: 0,
    group_output_index: 1,
    member_input_index: 2,
    penalty_output_index: 4,
  }
  covered_inputs_of(action) == [3, 7]
}

// Property: the field-blind decode returns exactly the list the action was built
// with, for any covered list.
test prop_covered_inputs_of__roundtrip(
  covered via fuzz.list(fuzz.int_between(0, 100)),
) {
  covered_inputs_of(cancel_action_data(covered)) == covered
}

// The mint-triggering variants are constr tag 0 in each family action type.
test action_tag__mint_variants_are_tag_zero() {
  let join: Data = JoinAction {
    covered_inputs: [],
    group_ref_input_index: 0,
    group_output_index: 0,
    member_input_index: 0,
    treasury_output_index: 0,
  }
  let propose: Data = ProposeAction {
    covered_inputs: [],
    group_ref_input_index: 0,
    request_output_index: 0,
    approver_input_indices: [],
  }
  let create: Data = CreateAction {
    covered_inputs: [],
    group_output_index: 0,
    reserve_output_index: 0,
  }
  and {
    action_tag_of(join) == 0,
    action_tag_of(propose) == 0,
    action_tag_of(create) == 0,
  }
}

// ─── action_covers_own_input (the pin rule) ───────────────────────────────────

// Accept: the family withdrawal's action covers the UTxO being spent.
test action_covers__accepts_covered_input() {
  let redeemers = family_redeemers(cancel_action_data([0]))
  action_covers_own_input(
    family_hash(),
    redeemers,
    test_inputs(2),
    input_ref(0),
  )
}

// Reject: the action covers a DIFFERENT input — the exact same-family
// two-input attack the pin rule exists for (one withdrawal validating input 1
// must not license spending input 0).
test action_covers__rejects_input_covered_elsewhere() {
  let redeemers = family_redeemers(cancel_action_data([1]))
  !action_covers_own_input(
    family_hash(),
    redeemers,
    test_inputs(2),
    input_ref(0),
  )
}

// Reject: the action covers nothing.
test action_covers__rejects_empty_coverage() {
  let redeemers = family_redeemers(cancel_action_data([]))
  !action_covers_own_input(
    family_hash(),
    redeemers,
    test_inputs(2),
    input_ref(0),
  )
}

// Reject (hard): the redeemer at the index belongs to a DIFFERENT withdrawal
// credential — a foreign family's action cannot vouch for this family's spend.
test action_covers__rejects_wrong_family() fail {
  let other_family = common.test_hash_06()
  let redeemers = [
    Pair(Withdraw(Script(other_family)), cancel_action_data([0])),
  ]
  action_covers_own_input(
    family_hash(),
    redeemers,
    test_inputs(2),
    input_ref(0),
  )
}

// Reject (hard): the redeemer at the index is not a withdrawal at all.
test action_covers__rejects_non_withdraw_purpose() fail {
  let redeemers = [Pair(Spend(input_ref(0)), cancel_action_data([0]))]
  action_covers_own_input(
    family_hash(),
    redeemers,
    test_inputs(2),
    input_ref(0),
  )
}

// Reject (hard): no redeemer at the claimed index.
test action_covers__rejects_missing_redeemer() fail {
  action_covers_own_input(family_hash(), [], test_inputs(2), input_ref(0))
}

// Property: coverage holds exactly when the spent UTxO's input index is in the
// action's covered list (4 inputs, arbitrary covered subset, arbitrary target).
test prop_action_covers__iff_membership(
  scenario via fuzz.both(
    fuzz.list(fuzz.int_between(0, 3)),
    fuzz.int_between(0, 3),
  ),
) {
  let (covered, target) = scenario
  let redeemers = family_redeemers(cancel_action_data(covered))
  let covers = action_covers_own_input(
    family_hash(),
    redeemers,
    test_inputs(4),
    input_ref(target),
  )
  covers == list.has(covered, target)
}

// ─── action_tag_is (the mint tag rule) ────────────────────────────────────────

// Accept: the family withdrawal runs the expected (mint-triggering) variant.
test action_tag_is__accepts_expected_tag() {
  let join: Data = JoinAction {
    covered_inputs: [],
    group_ref_input_index: 0,
    group_output_index: 1,
    member_input_index: 1,
    treasury_output_index: 0,
  }
  action_tag_is(family_hash(), family_redeemers(join), 0)
}

// Reject: a different action of the SAME family must not license the mint —
// without the tag check, an Exit action would license a JoinGroup mint.
test action_tag_is__rejects_wrong_variant() {
  let exit: Data = ExitAction {
    covered_inputs: [0],
    group_ref_input_index: 0,
    group_output_index: 1,
    member_input_index: 1,
    penalty_output_index: 0,
  }
  !action_tag_is(family_hash(), family_redeemers(exit), 0)
}

// Reject (hard): a foreign family's withdrawal cannot license the mint.
test action_tag_is__rejects_wrong_family() fail {
  let join: Data = JoinAction {
    covered_inputs: [],
    group_ref_input_index: 0,
    group_output_index: 1,
    member_input_index: 1,
    treasury_output_index: 0,
  }
  let redeemers = [Pair(Withdraw(Script(common.test_hash_06())), join)]
  action_tag_is(family_hash(), redeemers, 0)
}
