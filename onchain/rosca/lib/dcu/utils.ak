use aiken/collection/list
use aiken/interval.{Finite}
use cardano/assets.{PolicyId, Value, ada_policy_id}
use cardano/transaction.{Input, OutputReference, Transaction}

// get_lower_bound
// Extracts the Finite lower bound from a transaction's validity_range.
// Fails if the lower bound is not a Finite value (required for time-based checks).
pub fn get_lower_bound(tx: Transaction) -> Int {
  expect Finite(t) = tx.validity_range.lower_bound.bound_type
  t
}

// find_own_input
// Locates the input being spent (the validator's own UTxO) by its output
// reference. Shared by every spend handler in place of an inline list.find.
pub fn find_own_input(
  inputs: List<Input>,
  utxo: OutputReference,
) -> Option<Input> {
  list.find(inputs, fn(i) { i.output_reference == utxo })
}

// only_allowed_policies
// True iff every policy present in `value` is a member of `allowed` (a subset
// check). Used for clean-value checks that permit ADA + own policy + a fee asset.
pub fn only_allowed_policies(value: Value, allowed: List<PolicyId>) -> Bool {
  list.all(assets.policies(value), fn(p) { list.has(allowed, p) })
}

// output_holds_only_own
// True iff `value` holds exactly ADA and the given own policy and nothing else.
// `assets.policies` is sorted ascending and ada_policy_id (empty) sorts first.
pub fn output_holds_only_own(value: Value, own_policy: PolicyId) -> Bool {
  assets.policies(value) == [ada_policy_id, own_policy]
}
