use cardano/assets.{Value}
use cardano/transaction.{Input, NoDatum, Output, Transaction}
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

fn gate_tx(inputs: List<Input>, mint: Value) -> Transaction {
  Transaction { ..empty_tx(), inputs, mint }
}

fn authorize(inputs: List<Input>, mint: Value, dec_ix: Int) -> Bool {
  validate_authorize(
    gov_policy(),
    target_policy(),
    target_id(),
    dec_ix,
    1,
    ref_at(0),
    gate_tx(inputs, mint),
  )
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
    0,
    1,
    ref_at(9),
    tx,
  )
}
