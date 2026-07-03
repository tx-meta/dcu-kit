//// Mutual reserve (Cluster C) — validation logic for the per-group ReserveState
//// UTxO under the treasury validator. Kept in its own module (blueprint-identical
//// to inline, like dcu/quorum) so the reserve can be split into a dedicated
//// validator later without archaeology. Spec: 2026-07-03-cluster-c-reserve-design.md

use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, Transaction}
use dcu/cip68
use dcu/treasury.{ReserveState, TreasuryDatum}

// validate_create_reserve
// ─────────────────────────────────────────────────────────────────────────────
// Mint handler for CreateReserve. One reserve per group, forever:
// [spec Reserve create 1]: the group output sits at the TRUSTED group script and
//   holds exactly one group-policy token — the (100) ref token being created
// [spec Reserve create 2]: that group ref token is MINTED in this tx — the
//   one-shot coupling: group creation happens once (seed-input uniqueness), so a
//   reserve token can never be minted a second time for the same group
// [spec Reserve create 3]: own mint is exactly the reserve token (qty 1), whose
//   name is derived from the group ref name — deterministic, indexer-derivable
// [spec Reserve create 4]: the reserve output sits at the treasury script, holds
//   the reserve token, carries ReserveState{group binding, standin_rounds: 0},
//   and no foreign assets (only ADA + the reserve token at creation)
pub fn validate_create_reserve(
  own_policy_id: PolicyId,
  trusted_group_policy: PolicyId,
  group_output_index: Int,
  reserve_output_index: Int,
  tx: Transaction,
) -> Bool {
  let Transaction { outputs, mint, .. } = tx

  // [spec Reserve create 1]
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect
    group_output.address.payment_credential == Script(trusted_group_policy)
  expect [Pair(group_ref_name, 1)] = dict.to_pairs(
    assets.tokens(group_output.value, trusted_group_policy),
  )
  expect bytearray.take(group_ref_name, cip68.prefix_length) == cip68.prefix_100

  // [spec Reserve create 2]
  let group_ref_minted = assets.quantity_of(
    mint,
    trusted_group_policy,
    group_ref_name,
  ) == 1

  // [spec Reserve create 3]
  let reserve_token_name = cip68.convert_ref_to_reserve_token(group_ref_name)
  let exact_mint = dict.to_pairs(assets.tokens(mint, own_policy_id)) == [
    Pair(reserve_token_name, 1),
  ]

  // [spec Reserve create 4]
  expect Some(reserve_output) = list.at(outputs, reserve_output_index)
  expect InlineDatum(reserve_datum_data) = reserve_output.datum
  expect ReserveState { group_reference_tokenname, standin_rounds }: TreasuryDatum
    = reserve_datum_data

  and {
    group_ref_minted?,
    exact_mint?,
    (group_reference_tokenname == group_ref_name)?,
    (standin_rounds == 0)?,
    (reserve_output.address.payment_credential == Script(own_policy_id))?,
    (assets.without_lovelace(reserve_output.value) == assets.from_asset(
      own_policy_id,
      reserve_token_name,
      1,
    ))?,
  }
}

// group_reserve_minted
// ─────────────────────────────────────────────────────────────────────────────
// Group-side half of the create coupling (called next to validate_create_group in
// the group validator's CreateGroup mint path): the reserve token for THIS group —
// derived from the same seed input that derives the group's CIP-68 names — must be
// minted under the treasury policy in the same tx. Anti-brick rail: a group can
// never exist without its reserve, so levy-carrying joins always have a pot to pay.
pub fn group_reserve_minted(
  treasury_policy_id: PolicyId,
  seed_input: Input,
  mint: Value,
) -> Bool {
  let group_ref_name = cip68.unique_token_name(
    seed_input.output_reference,
    cip68.prefix_100,
  )
  assets.quantity_of(
    mint,
    treasury_policy_id,
    cip68.convert_ref_to_reserve_token(group_ref_name),
  ) == 1
}
