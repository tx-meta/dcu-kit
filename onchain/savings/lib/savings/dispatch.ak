use aiken/builtin
use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{ScriptHash}
use cardano/address.{Script}
use cardano/transaction.{
  Input, OutputReference, Redeemer, ScriptPurpose, Spend, Withdraw,
}

// dispatch — the thin vault's coupling to the two withdraw-zero families.
// ─────────────────────────────────────────────────────────────────────────────
// ADR-0003 splits savings into a thin spend/mint validator plus two family
// stake validators (`savings_governed`, `savings_direct`). The vault validates
// nothing heavy: every spend proves that its family's withdrawal exists and
// COVERS this UTxO, and every mint proves that the licensing family transition
// runs in the same transaction.
//
// Presence of a family withdrawal alone is not sufficient. With two vault
// inputs spent under the same family in one transaction, a single action
// validating only one of them would let the other through unvalidated. The pin
// rule closes that: the family action must explicitly cover the UTxO spent.
//
// The family withdrawal's redeemer is located BY PURPOSE (`Withdraw(Script(h))`
// in `tx.redeemers`) rather than by list index: the offchain SDK cannot predict
// the ledger's final redeemer ordering, and there is at most one withdrawal per
// credential per transaction.
//
// CONVENTION (declared in `savings/types`, enforced by the family validators,
// decoded here): field 0 of every family action variant is
// `covered_inputs: List<Int>`.

/// The family withdrawal's action redeemer, located by purpose. `None` when the
/// family withdrawal is absent — so a `Some` result also proves the family
/// stake validator executes in this transaction.
pub fn family_action(
  family_hash: ScriptHash,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
) -> Option<Redeemer> {
  pairs.get_first(redeemers, Withdraw(Script(family_hash)))
}

/// Decode `covered_inputs` from a family action without decoding the full
/// action type — the family validator re-decodes and binds the whole variant.
pub fn covered_inputs_of(rdata: Redeemer) -> List<Int> {
  expect covered: List<Int> = builtin.un_constr_data(rdata)
    |> builtin.snd_pair
    |> builtin.head_list
  covered
}

/// Constructor tag of any redeemer.
pub fn tag_of(rdata: Redeemer) -> Int {
  builtin.un_constr_data(rdata) |> builtin.fst_pair
}

/// Field 0 of a spending redeemer as a byte string — the ADR-0002 intent
/// commitment, read exactly the way the Governance Gate reads it.
pub fn intent_of(rdata: Redeemer) -> ByteArray {
  expect intent: ByteArray = builtin.un_constr_data(rdata)
    |> builtin.snd_pair
    |> builtin.head_list
  intent
}

/// The spending redeemer of `utxo`. Fails when the transaction does not spend
/// it, so a family action can never claim to validate an absent input.
pub fn spend_redeemer_of(
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  utxo: OutputReference,
) -> Redeemer {
  expect Some(rdata) = pairs.get_first(redeemers, Spend(utxo))
  rdata
}

/// [security]: pin rule for vault spends, applied to EVERY vault input the
/// transaction consumes — anchor and satellites alike. Three things must hold:
///
/// 1. the named family's withdrawal is present (found by purpose, so its stake
///    validator provably executes);
/// 2. its action is the variant this spending redeemer's constructor names —
///    without this, a satellite could be spent under a different operation's
///    constructor than the one actually running, so the redeemer a Gate or an
///    indexer reads off that input would not describe the transition; and
/// 3. the action's `covered_inputs` includes the UTxO being spent, so a second
///    same-family vault input cannot ride an action that does not validate it.
///
/// Checks 2 and 3 share one redeemer lookup.
pub fn action_binds_own_input(
  family_hash: ScriptHash,
  expected_tag: Int,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  inputs: List<Input>,
  utxo: OutputReference,
) -> Bool {
  when family_action(family_hash, redeemers) is {
    Some(rdata) -> and {
        (tag_of(rdata) == expected_tag)?,
        list.any(
          covered_inputs_of(rdata),
          fn(i) {
            expect Some(covered_input) = list.at(inputs, i)
            covered_input.output_reference == utxo
          },
        )?,
      }
    None -> False
  }
}

/// [security]: mint-side family coupling. The named family's withdrawal must be
/// present AND its action must be the expected variant. Without the tag check
/// any action of the family would license the mint; without the family check a
/// burn could be attributed to the wrong family entirely.
pub fn action_tag_is(
  family_hash: ScriptHash,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  expected_tag: Int,
) -> Bool {
  when family_action(family_hash, redeemers) is {
    Some(rdata) -> tag_of(rdata) == expected_tag
    None -> False
  }
}
