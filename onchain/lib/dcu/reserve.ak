//// Mutual reserve (Cluster C) — validation logic for the per-group ReserveState
//// UTxO under the treasury validator. Kept in its own module (blueprint-identical
//// to inline, like dcu/quorum) so the reserve can be split into a dedicated
//// validator later without archaeology. Spec: 2026-07-03-cluster-c-reserve-design.md

use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId, Value, ada_policy_id}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}
use dcu/cip68
use dcu/group.{GroupCip68Datum, GroupDatum}
use dcu/treasury.{DefaultState, ReserveState, TreasuryDatum}
use dcu/treasury_utils.{contributable_in}
use dcu/utils.{only_allowed_policies}

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

// validate_reserve_topup
// ─────────────────────────────────────────────────────────────────────────────
// Increase-only spend of the ReserveState UTxO — join levies and voluntary
// top-ups (harambee) share this path:
// [spec Reserve topup 1]: self-reference — the indexed input IS the UTxO being
//   spent, and it holds the reserve token derived from its own datum binding
// [spec Reserve topup 2]: the bound group is present — as a reference input
//   (standalone top-up) or a spending input (join) — at the trusted group script;
//   it supplies the contribution-asset identity
// [spec Reserve topup 3]: the continuation output is pinned — same full address
//   (AIK-4), same datum, the reserve token carried, and no foreign assets
// [spec Reserve topup 4]: the contribution-asset balance STRICTLY grows and
//   lovelace never decreases — nothing can leave through this redeemer
pub fn validate_reserve_topup(
  own_policy_id: PolicyId,
  trusted_group_policy: PolicyId,
  reserve_input_index: Int,
  reserve_output_index: Int,
  reserve_datum: TreasuryDatum,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, reference_inputs, outputs, .. } = tx

  // [spec Reserve topup 1]
  expect Some(reserve_input) = list.at(inputs, reserve_input_index)
  expect reserve_input.output_reference == utxo
  expect ReserveState { group_reference_tokenname, standin_rounds } =
    reserve_datum
  let reserve_token_name = cip68.convert_ref_to_reserve_token(
    group_reference_tokenname,
  )
  expect
    assets.quantity_of(
      reserve_input.output.value,
      own_policy_id,
      reserve_token_name,
    ) == 1

  // [spec Reserve topup 2]
  let group = resolve_bound_group(
    inputs,
    reference_inputs,
    trusted_group_policy,
    group_reference_tokenname,
  )

  expect Some(reserve_output) = list.at(outputs, reserve_output_index)
  expect InlineDatum(out_datum_data) = reserve_output.datum
  expect ReserveState {
    group_reference_tokenname: out_binding,
    standin_rounds: out_standin,
  }: TreasuryDatum = out_datum_data

  let in_contributable = contributable_in(
    reserve_input.output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )
  let out_contributable = contributable_in(
    reserve_output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )

  and {
    // [spec Reserve topup 3]
    (out_binding == group_reference_tokenname)?,
    (out_standin == standin_rounds)?,
    (reserve_output.address == reserve_input.output.address)?,
    (dict.to_pairs(assets.tokens(reserve_output.value, own_policy_id)) == [
      Pair(reserve_token_name, 1),
    ])?,
    only_allowed_policies(
      reserve_output.value,
      [ada_policy_id, own_policy_id, group.contribution_fee_policyid],
    )?,
    // [spec Reserve topup 4]
    (out_contributable > in_contributable)?,
    (assets.lovelace_of(reserve_output.value) >= assets.lovelace_of(
      reserve_input.output.value,
    ))?,
  }
}

// resolve_bound_group
// ─────────────────────────────────────────────────────────────────────────────
// Locate the group UTxO bound to a reserve (by its ref token) at the TRUSTED
// group script — among reference inputs first (standalone reserve operations),
// then among spending inputs (join / distribute / terminate ride-alongs).
pub fn resolve_bound_group(
  inputs: List<Input>,
  reference_inputs: List<Input>,
  trusted_group_policy: PolicyId,
  group_reference_tokenname: AssetName,
) -> GroupDatum {
  let holds_group = fn(i: Input) {
    i.output.address.payment_credential == Script(trusted_group_policy) && assets.quantity_of(
      i.output.value,
      trusted_group_policy,
      group_reference_tokenname,
    ) == 1
  }
  let group_utxo = when list.find(reference_inputs, holds_group) is {
    Some(i) -> i
    None -> {
      expect Some(i) = list.find(inputs, holds_group)
      i
    }
  }
  expect InlineDatum(group_datum_data) = group_utxo.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data
  group
}

// standin_increment
// ─────────────────────────────────────────────────────────────────────────────
// The terminated defaulter's remaining contribution rounds in the current lap —
// the fee-units the reserve stands in for (spec §5). Era-relative; 0 for a
// group that is not started (no rotation to stand in for).
pub fn standin_increment(group: GroupDatum) -> Int {
  if group.is_started {
    let remaining =
      group.era_start_round + group.num_rounds - (
        group.last_distributed_round + 1
      )
    if remaining > 0 {
      remaining
    } else {
      0
    }
  } else {
    0
  }
}

// reserve_cover_transition
// ─────────────────────────────────────────────────────────────────────────────
// The exact reserve transition of a TerminateDefault: forfeit flows in, the
// stand-in counter grows by the defaulter's remaining rounds, everything else
// pinned. Shared by validate_terminate_default (defaulter-input side) and
// validate_reserve_cover (reserve-input side) so the two legs can never drift.
pub fn reserve_cover_transition(
  own_policy_id: PolicyId,
  group: GroupDatum,
  expected_group_token_name: AssetName,
  forfeit: Int,
  reserve_in: Input,
  reserve_out: Output,
) -> Bool {
  let reserve_token_name = cip68.convert_ref_to_reserve_token(
    expected_group_token_name,
  )
  expect InlineDatum(in_datum_data) = reserve_in.output.datum
  expect ReserveState {
    group_reference_tokenname: in_binding,
    standin_rounds: standin_in,
  }: TreasuryDatum = in_datum_data

  expect InlineDatum(out_datum_data) = reserve_out.datum
  expect ReserveState {
    group_reference_tokenname: out_binding,
    standin_rounds: standin_out,
  }: TreasuryDatum = out_datum_data

  let in_contributable = contributable_in(
    reserve_in.output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )
  let out_contributable = contributable_in(
    reserve_out.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )

  and {
    (assets.quantity_of(
      reserve_in.output.value,
      own_policy_id,
      reserve_token_name,
    ) == 1)?,
    (in_binding == expected_group_token_name)?,
    (out_binding == expected_group_token_name)?,
    (standin_out == standin_in + standin_increment(group))?,
    (reserve_out.address == reserve_in.output.address)?,
    (dict.to_pairs(assets.tokens(reserve_out.value, own_policy_id)) == [
      Pair(reserve_token_name, 1),
    ])?,
    only_allowed_policies(
      reserve_out.value,
      [ada_policy_id, own_policy_id, group.contribution_fee_policyid],
    )?,
    // [spec Reserve C5]: the defaulter's own assets first — the full forfeited
    // contributable balance lands in the pot (over-funding allowed).
    (out_contributable >= in_contributable + forfeit)?,
    (assets.lovelace_of(reserve_out.value) >= assets.lovelace_of(
      reserve_in.output.value,
    ))?,
  }
}

// validate_reserve_cover
// ─────────────────────────────────────────────────────────────────────────────
// Spend handler for the reserve input of a TerminateDefault tx. Pins the spend
// to a GENUINE termination — the shape only TerminateDefault produces:
// [spec Reserve cover 1]: the defaulter input is a DefaultState of THIS group
// [spec Reserve cover 2]: the defaulter's membership token is BURNED in this tx
//   (recovery rotations relocate, Contribute recoveries keep — neither burns
//   while removing the member below)
// [spec Reserve cover 3]: the group output removes the member (member_count-1) —
//   ExecuteRecovery keeps the count, so cover cannot ride a rotation
// [spec Reserve cover 4]: the reserve transition itself (shared with the
//   terminate side): forfeit in, stand-in counter += remaining rounds, pinned.
pub fn validate_reserve_cover(
  own_policy_id: PolicyId,
  trusted_group_policy: PolicyId,
  group_ref_input_index: Int,
  group_output_index: Int,
  defaulter_input_index: Int,
  reserve_input_index: Int,
  reserve_output_index: Int,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, mint, .. } = tx

  // self-reference
  expect Some(reserve_in) = list.at(inputs, reserve_input_index)
  expect reserve_in.output_reference == utxo

  // trusted group (spending input — terminate spends the group with Exit)
  expect Some(group_input) = list.at(inputs, group_ref_input_index)
  expect
    group_input.output.address.payment_credential == Script(
      trusted_group_policy,
    )
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data
  expect [Pair(expected_group_token_name, 1)] = dict.to_pairs(
    assets.tokens(group_input.output.value, trusted_group_policy),
  )

  // [spec Reserve cover 3]
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(group_out_data) = group_output.datum
  expect GroupCip68Datum { extra: updated_group, .. } = group_out_data
  let member_removed = updated_group.member_count == group.member_count - 1

  // [spec Reserve cover 1]
  expect Some(defaulter_input) = list.at(inputs, defaulter_input_index)
  expect InlineDatum(defaulter_datum_data) = defaulter_input.output.datum
  expect DefaultState {
    member_reference_tokenname: defaulter_token,
    group_reference_tokenname: defaulter_binding,
    ..
  }: TreasuryDatum = defaulter_datum_data
  let defaulter_of_this_group = defaulter_binding == expected_group_token_name

  // [spec Reserve cover 2]
  let token_burned = assets.quantity_of(mint, own_policy_id, defaulter_token) == -1

  let forfeit = contributable_in(
    defaulter_input.output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )

  expect Some(reserve_out) = list.at(outputs, reserve_output_index)

  and {
    member_removed?,
    defaulter_of_this_group?,
    token_burned?,
    // [spec Reserve cover 4]
    reserve_cover_transition(
      own_policy_id,
      group,
      expected_group_token_name,
      forfeit,
      reserve_in,
      reserve_out,
    )?,
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
