use aiken/builtin
use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{ScriptHash}
use cardano/address.{Script}
use cardano/transaction.{
  Input, OutputReference, Redeemer, ScriptPurpose, Withdraw,
}

// dispatch — the treasury dispatcher's coupling to the family stake validators.
// ─────────────────────────────────────────────────────────────────────────────
// The treasury spend/mint script delegates all heavy validation to one of four
// withdraw-zero stake validators (rounds / lifecycle / recovery / reserve, hashes
// published in ProtocolSettings). Presence of a family withdrawal alone is NOT
// sufficient: with two treasury inputs spent under the same family in one tx, a
// single withdrawal validating only one of them would let the other through
// unvalidated. The pin rule closes that: the family action must explicitly cover
// the UTxO being spent.
//
// The family withdrawal's redeemer is located BY PURPOSE (`Withdraw(Script(hash))`
// in tx.redeemers) rather than by a redeemer-list index: there is exactly one
// withdrawal per credential per tx, so the lookup is unambiguous, and the offchain
// SDK cannot reliably predict the final redeemer-list ordering.
//
// CONVENTION (enforced by the family validators, decoded here): the FIRST field
// of every family action variant is `covered_inputs: List<Int>` — the treasury
// spending inputs that action validates. The mint-triggering variant of every
// family action type is the FIRST constructor (constr tag 0).

/// The family withdrawal's action redeemer, located by purpose. Fails when the
/// family withdrawal is absent — which also proves the family stake validator
/// executes in this tx when the lookup succeeds.
pub fn family_action_of(
  family_hash: ScriptHash,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
) -> Redeemer {
  expect Some(rdata) = pairs.get_first(redeemers, Withdraw(Script(family_hash)))
  rdata
}

/// Decode the `covered_inputs` list from a family action redeemer without
/// decoding the full action type (keeps the dispatcher small — the family
/// validator decodes and re-binds the full type).
pub fn covered_inputs_of(rdata: Redeemer) -> List<Int> {
  let fields = builtin.un_constr_data(rdata) |> builtin.snd_pair
  expect covered: List<Int> = builtin.head_list(fields)
  covered
}

/// Constructor tag of a family action redeemer.
pub fn action_tag_of(rdata: Redeemer) -> Int {
  builtin.un_constr_data(rdata) |> builtin.fst_pair
}

/// [security]: pin rule for treasury spends. The family withdrawal must be
/// present (found by purpose — its stake validator therefore executes) and its
/// action's `covered_inputs` must include the UTxO being spent — so a second
/// same-family treasury input cannot ride an action that does not validate it.
pub fn action_covers_own_input(
  family_hash: ScriptHash,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  inputs: List<Input>,
  utxo: OutputReference,
) -> Bool {
  list.any(
    covered_inputs_of(family_action_of(family_hash, redeemers)),
    fn(i) {
      expect Some(covered_input) = list.at(inputs, i)
      covered_input.output_reference == utxo
    },
  )
}

/// [security]: mint-side family coupling. The family withdrawal must be present
/// AND its action must be the expected variant (constr tag) — without the tag
/// check, ANY action of the family (e.g. an Exit) would license the mint (e.g. a
/// JoinGroup token).
pub fn action_tag_is(
  family_hash: ScriptHash,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  expected_tag: Int,
) -> Bool {
  action_tag_of(family_action_of(family_hash, redeemers)) == expected_tag
}
