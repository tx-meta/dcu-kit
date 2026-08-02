use aiken/builtin
use aiken/collection/list
use cardano/assets.{Value}
use cardano/transaction.{Input, NoDatum, Output, Spend, Transaction}
use governance/types.{Generic, GovAction, ParamChange}
use governance/validation.{validate_authorize}
use tests/common.{
  dispatcher_address, empty_tx, gate_address, gov_policy, member_policy, ref_at,
  target_id, target_policy, with_ada,
}

fn decision_name() -> ByteArray {
  #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
}

// The decision UTxO at the gate, holding the one-shot decision token.
fn decision_input() -> Input {
  Input {
    output_reference: ref_at(0),
    output: Output {
      address: gate_address(),
      value: with_ada(assets.from_asset(gov_policy(), decision_name(), 1)),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// The governed vault input — carries its state NFT under the exact
// (target_policy, target_id).
fn target_input() -> Input {
  Input {
    output_reference: ref_at(2),
    output: Output {
      address: dispatcher_address(),
      value: with_ada(assets.from_asset(target_policy(), target_id(), 1)),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// A decoy: the SAME token name minted under a DIFFERENT (permissionless)
// policy — the CRIT-2 exploit shape.
fn decoy_target_input() -> Input {
  Input {
    output_reference: ref_at(3),
    output: Output {
      address: dispatcher_address(),
      value: with_ada(assets.from_asset(member_policy(), target_id(), 1)),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// A vault input that does NOT carry the target token at all.
fn wrong_target_input() -> Input {
  Input {
    output_reference: ref_at(4),
    output: Output {
      address: dispatcher_address(),
      value: assets.from_lovelace(5_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn burn_decision() -> Value {
  assets.from_asset(gov_policy(), decision_name(), -1)
}

// The redeemer the governed vault runs. The decision commits to these exact
// bytes, so the tx must carry it against the target input.
fn target_redeemer() -> Data {
  builtin.i_data(42)
}

// The action a decision carries by default: Generic wrapping the target
// redeemer's CBOR verbatim, which is how a family keeps its own redeemer type.
fn bound_action() -> GovAction {
  Generic { tag: 0, payload: builtin.serialise_data(target_redeemer()) }
}

// Every input carries the same redeemer, so a test that swaps the target input
// still has one for it and fails on the check it names rather than on a missing
// redeemer lookup.
fn gate_tx(inputs: List<Input>, mint: Value) -> Transaction {
  Transaction {
    ..empty_tx(),
    inputs,
    mint,
    redeemers: list.map(
      inputs,
      fn(i) { Pair(Spend(i.output_reference), target_redeemer()) },
    ),
  }
}

fn authorize_action(
  inputs: List<Input>,
  mint: Value,
  dec_ix: Int,
  action: GovAction,
) -> Bool {
  validate_authorize(
    gov_policy(),
    target_policy(),
    target_id(),
    action,
    dec_ix,
    1,
    ref_at(0),
    gate_tx(inputs, mint),
  )
}

fn authorize(inputs: List<Input>, mint: Value, dec_ix: Int) -> Bool {
  authorize_action(inputs, mint, dec_ix, bound_action())
}

test gate__accepts_bound_and_burned() {
  authorize([decision_input(), target_input()], burn_decision(), 0)
}

test gate__rejects_no_burn() {
  // The decision is spent but NOT burned — it could be replayed.
  !authorize([decision_input(), target_input()], assets.zero, 0)
}

test gate__rejects_decoy_target() {
  // Same token NAME under a different policy — must not satisfy the binding.
  !authorize([decision_input(), decoy_target_input()], burn_decision(), 0)
}

test gate__rejects_wrong_target() {
  // The decision is bound to target_id, but the named input is a different vault.
  !authorize([decision_input(), wrong_target_input()], burn_decision(), 0)
}

test gate__rejects_self_reference_mismatch() {
  // The decision_input_index points at an input that is not the UTxO being spent.
  let tx = gate_tx([decision_input(), target_input()], burn_decision())
  !validate_authorize(
    gov_policy(),
    target_policy(),
    target_id(),
    bound_action(),
    0,
    1,
    ref_at(9),
    tx,
  )
}

test gate__rejects_action_the_decision_did_not_authorize() {
  // The decision authorizes one operation; the target input runs a different
  // redeemer. Without the binding, one passed proposal authorizes ANY operation
  // on that vault.
  let other = Generic {
    tag: 0,
    payload: builtin.serialise_data(builtin.i_data(7)),
  }
  !authorize_action(
    [decision_input(), target_input()],
    burn_decision(),
    0,
    other,
  )
}

test gate__accepts_a_typed_action_used_as_the_redeemer() {
  // A family that adopts GovAction as its own redeemer binds on the action's
  // own serialisation rather than on a Generic payload.
  let action = ParamChange { field_tag: 1, new_value: 9 }
  let as_redeemer: Data = action
  let tx = Transaction {
    ..empty_tx(),
    inputs: [decision_input(), target_input()],
    mint: burn_decision(),
    redeemers: [Pair(Spend(ref_at(2)), as_redeemer)],
  }
  validate_authorize(
    gov_policy(),
    target_policy(),
    target_id(),
    action,
    0,
    1,
    ref_at(0),
    tx,
  )
}

test gate__rejects_target_without_a_redeemer() {
  // A target spent with no redeemer (a wallet or native-script UTxO) cannot
  // carry an action, so nothing can be bound to it.
  let tx = Transaction {
    ..empty_tx(),
    inputs: [decision_input(), target_input()],
    mint: burn_decision(),
    redeemers: [],
  }
  !validate_authorize(
    gov_policy(),
    target_policy(),
    target_id(),
    bound_action(),
    0,
    1,
    ref_at(0),
    tx,
  )
}

// A vault redeemer that carries input indices resolved at build time — the
// ordinary shape. Its exact bytes are unknowable when a proposal is opened, so
// a decision binds the OPERATION (constructor 3) rather than the bytes.
fn indexed_redeemer(constructor: Int, index: Int) -> Data {
  builtin.constr_data(constructor, [builtin.i_data(index)])
}

fn gate_tx_with(target_redeemer: Data, mint: Value) -> Transaction {
  let inputs = [decision_input(), target_input()]
  Transaction {
    ..empty_tx(),
    inputs,
    mint,
    redeemers: list.map(
      inputs,
      fn(i) { Pair(Spend(i.output_reference), target_redeemer) },
    ),
  }
}

test gate__accepts_the_operation_the_decision_named() {
  // Generic with an EMPTY payload binds the redeemer's constructor only.
  let action = Generic { tag: 3, payload: "" }
  validate_authorize(
    gov_policy(),
    target_policy(),
    target_id(),
    action,
    0,
    1,
    ref_at(0),
    gate_tx_with(indexed_redeemer(3, 7), burn_decision()),
  )
}

test gate__rejects_a_different_operation_on_the_same_vault() {
  // The decision named operation 3; the vault runs operation 4.
  let action = Generic { tag: 3, payload: "" }
  !validate_authorize(
    gov_policy(),
    target_policy(),
    target_id(),
    action,
    0,
    1,
    ref_at(0),
    gate_tx_with(indexed_redeemer(4, 7), burn_decision()),
  )
}

test gate__operation_binding_ignores_the_resolved_indices() {
  // The same operation with a different input index still satisfies the
  // decision: indices are transaction layout, not intent.
  let action = Generic { tag: 3, payload: "" }
  validate_authorize(
    gov_policy(),
    target_policy(),
    target_id(),
    action,
    0,
    1,
    ref_at(0),
    gate_tx_with(indexed_redeemer(3, 99), burn_decision()),
  )
}
