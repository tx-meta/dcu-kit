use aiken/builtin
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken_design_patterns/stake_validator
use cardano/transaction.{Input, OutputReference, Redeemer, ScriptPurpose}

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
// CONVENTION (enforced by the family validators, decoded here): the FIRST field
// of every family action variant is `covered_inputs: List<Int>` — the treasury
// spending inputs that action validates. The mint-triggering variant of every
// family action type is the FIRST constructor (constr tag 0).

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

/// [security]: pin rule for treasury spends. The redeemer at
/// `withdraw_redeemer_index` must have purpose `Withdraw(Script(family_hash))`
/// (which also proves the family validator executes in this tx), and its action's
/// `covered_inputs` must include the UTxO being spent — so a second same-family
/// treasury input cannot ride an action that does not validate it.
pub fn action_covers_own_input(
  family_hash: ScriptHash,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  withdraw_redeemer_index: Int,
  inputs: List<Input>,
  utxo: OutputReference,
) -> Bool {
  stake_validator.validate_withdraw(
    family_hash,
    redeemers,
    withdraw_redeemer_index,
    fn(rdata) {
      list.any(
        covered_inputs_of(rdata),
        fn(i) {
          expect Some(covered_input) = list.at(inputs, i)
          covered_input.output_reference == utxo
        },
      )
    },
  )
}

/// [security]: mint-side family coupling. The redeemer at
/// `withdraw_redeemer_index` must be the family withdrawal AND its action must be
/// the expected variant (constr tag) — without the tag check, ANY action of the
/// family (e.g. an Exit) would license the mint (e.g. a JoinGroup token).
pub fn action_tag_is(
  family_hash: ScriptHash,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  withdraw_redeemer_index: Int,
  expected_tag: Int,
) -> Bool {
  stake_validator.validate_withdraw(
    family_hash,
    redeemers,
    withdraw_redeemer_index,
    fn(rdata) { action_tag_of(rdata) == expected_tag },
  )
}
