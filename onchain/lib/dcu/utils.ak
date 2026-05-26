use aiken/interval.{Finite}
use cardano/transaction.{Transaction}

// get_lower_bound
// Extracts the Finite lower bound from a transaction's validity_range.
// Fails if the lower bound is not a Finite value (required for time-based checks).
pub fn get_lower_bound(tx: Transaction) -> Int {
  expect Finite(t) = tx.validity_range.lower_bound.bound_type
  t
}
