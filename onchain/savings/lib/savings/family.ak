use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Credential, Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, Input, OutputReference, Redeemer, Transaction,
}
use savings/dispatch.{spend_redeemer_of, tag_of}
use savings/types.{SavingsDatum}
use savings/validation.{own_input_count_is}

// family — the coverage discipline every family withdrawal opens with.
// ─────────────────────────────────────────────────────────────────────────────
// ADR-0003's coverage invariant: every vault input a transaction consumes must
// be covered EXACTLY ONCE by the family action, anchor and satellites alike.
// Partial coverage, duplicate coverage, foreign-input coverage and
// mixed-operation batching are all rejected here, once, before any operation
// logic runs — so no family arm can forget it.
//
// The primary input (fund anchor, or the member/loan record for the standalone
// operations) supplies BOTH the validated datum and the spending redeemer that
// carries the ADR-0002 intent commitment at field 0.

/// The inline `SavingsDatum` of an input (fails on anything else).
pub fn input_datum(input: Input) -> SavingsDatum {
  expect InlineDatum(raw) = input.output.datum
  expect d: SavingsDatum = raw
  d
}

/// True when `refs` contains the same output reference more than once.
fn has_duplicate(refs: List<OutputReference>) -> Bool {
  when refs is {
    [] -> False
    [head, ..rest] -> list.has(rest, head) || has_duplicate(rest)
  }
}

/// Opens a family action: proves the withdrawal is a genuine 0-ADA withdraw-zero
/// trigger, that the covered set is exactly the vault inputs this transaction
/// consumes, and that the primary input is spent with `op_tag`.
///
/// Returns the primary input, the vault policy id derived from it, and the
/// primary's spending redeemer (whose field 0 the governed arms read as the
/// intent commitment).
///
/// [security] in order:
/// - exactly one withdrawal from this credential, for exactly 0 — a non-zero
///   withdrawal or a duplicated one cannot smuggle a second action through;
/// - the primary input sits at a script credential, which IS the vault policy;
/// - every covered index resolves to an input this transaction consumes, at
///   that same script — a foreign-script input can never be covered;
/// - the covered set is duplicate-free and exactly `family_size` long, and the
///   transaction consumes exactly `family_size` vault inputs — so coverage is
///   total (no uncovered anchor or satellite) and two operations cannot batch;
/// - the primary is itself covered;
/// - the primary's spending redeemer has the operation's constructor tag, so a
///   governed decision cannot be executed under a different operation.
pub fn open(
  self: Transaction,
  credential: Credential,
  covered_inputs: List<Int>,
  primary_index: Int,
  family_size: Int,
  op_tag: Int,
) -> (Input, PolicyId, Redeemer) {
  expect [0] = pairs.get_all(self.withdrawals, credential)
  expect Some(primary) = list.at(self.inputs, primary_index)
  expect Script(policy_id) = primary.output.address.payment_credential
  let refs = list.map(
    covered_inputs,
    fn(i) {
      expect Some(covered_input) = list.at(self.inputs, i)
      expect
        covered_input.output.address.payment_credential == Script(policy_id)
      covered_input.output_reference
    },
  )
  expect list.length(refs) == family_size
  expect own_input_count_is(self.inputs, policy_id, family_size)
  expect !has_duplicate(refs)
  expect list.has(refs, primary.output_reference)
  let rdata = spend_redeemer_of(self.redeemers, primary.output_reference)
  expect tag_of(rdata) == op_tag
  (primary, policy_id, rdata)
}
