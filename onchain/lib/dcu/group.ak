use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value, ada_policy_id}
use cardano/transaction.{InlineDatum, Input, Output}
use dcu/cip68

/// Group Validator Datum
pub type GroupDatum {
  contribution_fee_policyid: PolicyId,
  contribution_fee_assetname: AssetName,
  contribution_fee: Int,
  joining_fee_policyid: PolicyId,
  joining_fee_assetname: AssetName,
  joining_fee: Int,
  penalty_fee_policyid: PolicyId,
  penalty_fee_assetname: AssetName,
  penalty_fee: Int,
  interval_length: Int,
  num_intervals: Int,
  member_count: Int,
  is_active: Bool,
  // POSIX millisecond timestamp when the ROSCA rotation schedule begins.
  // Required by the treasury validator for slot calculation:
  //   current_slot = (now - start_time) / interval_length % num_intervals
  start_time: Int,
}

/// Group Validator Mint Redeemer
pub type GroupMintRedeemer {
  CreateGroup { input_index: Int, output_index: Int }
}

/// Group Validator Spend Redeemer
pub type GroupSpendRedeemer {
  UpdateGroup {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
    group_output_index: Int,
  }
  RemoveGroup {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
    group_output_index: Int,
  }
  MemberJoin {
    group_ref_token_name: AssetName,
    group_input_index: Int,
    group_output_index: Int,
  }
  MemberExit {
    group_ref_token_name: AssetName,
    group_input_index: Int,
    group_output_index: Int,
  }
}

// validate_create_group
// ─────────────────────────────────────────────────────────────────────────────
// [spec CreateGroup 1]: output at output_index is at the Group Script address
// [spec CreateGroup 2]: exactly two tokens minted — ref_tn qty 1, user_tn qty 1
// [spec CreateGroup 3]: input at input_index consumed to derive unique CIP-68 names
// [spec CreateGroup 4]: contribution_fee > 0
// [spec CreateGroup 5]: joining_fee >= 0
// [spec CreateGroup 6]: penalty_fee >= 0
// [spec CreateGroup 7]: interval_length > 0
// [spec CreateGroup 8]: num_intervals > 0 and <= 100 (upper bound prevents unbounded
//                       contribution_list growth in treasury datums)
// [spec CreateGroup 9]: member_count == 0 at creation
// [spec CreateGroup 10]: is_active == True at creation
// [spec CreateGroup 11]: user (222) token must go to a VerificationKey address —
//                        if sent to a script, admin authority is permanently lost
pub fn validate_create_group(
  policy_id: PolicyId,
  input_index: Int,
  output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  expect Some(output) = list.at(outputs, output_index)
  expect InlineDatum(d) = output.datum
  expect datum: GroupDatum = d

  expect Some(params_input) = list.at(inputs, input_index)

  let ref_token_name =
    cip68.unique_token_name(params_input.output_reference, cip68.prefix_100)
  let user_token_name =
    cip68.unique_token_name(params_input.output_reference, cip68.prefix_222)

  let minted_tokens = assets.tokens(mint, policy_id)
  expect Some(1) = dict.get(minted_tokens, ref_token_name)
  expect Some(1) = dict.get(minted_tokens, user_token_name)
  let exact_mint_quantity = dict.size(minted_tokens) == 2

  expect Some(user_output) =
    list.find(
      outputs,
      fn(o) { assets.quantity_of(o.value, policy_id, user_token_name) == 1 },
    )
  let user_token_to_wallet =
    when user_output.address.payment_credential is {
      VerificationKey(_) -> True
      Script(_) -> False
    }

  let output_at_script_address =
    output.address.payment_credential == Script(policy_id)

  let output_has_ref_token =
    assets.quantity_of(output.value, policy_id, ref_token_name) == 1

  // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
  let output_clean_value =
    assets.policies(output.value) == [ada_policy_id, policy_id]

  and {
    exact_mint_quantity?,
    output_at_script_address?,
    output_has_ref_token?,
    output_clean_value?,
    user_token_to_wallet?,
    (datum.contribution_fee > 0)?,
    (datum.joining_fee >= 0)?,
    (datum.penalty_fee >= 0)?,
    (datum.interval_length > 0)?,
    (datum.num_intervals > 0)?,
    (datum.num_intervals <= 100)?,
    (datum.member_count == 0)?,
    datum.is_active?,
  }
}

// validate_update_group
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check (group_input_index resolves to the UTxO being spent)
//       is enforced at the entry point in group-validator.ak before this function
//       is called — matching the payment-subscription pattern.
//
// [spec UpdateGroup 1]: group input at group_input_index holds the ref token
// [spec UpdateGroup 2]: admin input at admin_input_index holds the user (222) token
// [security        3]: critical fields (fee amounts + policy IDs + asset names +
//                      intervals) are only changeable when member_count == 0;
//                      changing fee currency is as disruptive as changing the amount
// [spec UpdateGroup 4]: group output is at the same script address with ref token
// [spec UpdateGroup 5]: member_count is unchanged (managed by treasury join/exit)
// [spec UpdateGroup 6]: is_active remains True (use RemoveGroup to deactivate)
// [security        7]: ADA must not decrease from input to output
pub fn validate_update_group(
  policy_id: PolicyId,
  group_ref_token_name: AssetName,
  admin_input_index: Int,
  group_input_index: Int,
  group_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
) -> Bool {
  // 1. Find Group Input
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  // 2. Validate Admin Authorization
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let user_token_name =
    cip68.prefix_222
      |> bytearray.concat(
          bytearray.drop(group_ref_token_name, cip68.prefix_length),
        )
  expect
    assets.quantity_of(admin_input.output.value, policy_id, user_token_name) == 1

  // 3. Validate Group Output
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(datum_data) = group_output.datum
  expect updated_datum: GroupDatum = datum_data

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current_datum: GroupDatum = input_datum_data

  // [security 3]: critical fields include amounts AND policy IDs AND asset names.
  // Switching fee currency (e.g. ADA → admin-controlled token) is an economic rug-pull
  // equivalent to raising the fee — both must be frozen while any member is active.
  let is_critical_update =
    updated_datum.contribution_fee != current_datum.contribution_fee || updated_datum.contribution_fee_policyid != current_datum.contribution_fee_policyid || updated_datum.contribution_fee_assetname != current_datum.contribution_fee_assetname || updated_datum.joining_fee != current_datum.joining_fee || updated_datum.joining_fee_policyid != current_datum.joining_fee_policyid || updated_datum.joining_fee_assetname != current_datum.joining_fee_assetname || updated_datum.penalty_fee != current_datum.penalty_fee || updated_datum.penalty_fee_policyid != current_datum.penalty_fee_policyid || updated_datum.penalty_fee_assetname != current_datum.penalty_fee_assetname || updated_datum.interval_length != current_datum.interval_length || updated_datum.num_intervals != current_datum.num_intervals

  let is_safe_update = !is_critical_update || current_datum.member_count == 0

  // [security 7]: ADA preservation — admin must not drain the group UTxO during update
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
  let output_clean_value =
    assets.policies(group_output.value) == [ada_policy_id, policy_id]

  and {
    (group_output.address == group_input.output.address)?,
    (assets.quantity_of(group_output.value, policy_id, group_ref_token_name) == 1)?,
    output_clean_value?,
    is_safe_update?,
    (updated_datum.member_count == current_datum.member_count)?,
    updated_datum.is_active?,
    (out_ada >= in_ada)?,
  }
}

// validate_remove_group
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check (group_input_index resolves to the UTxO being spent)
//       is enforced at the entry point in group-validator.ak before this function
//       is called — matching the payment-subscription pattern.
//
// [spec RemoveGroup 1]: group input at group_input_index holds the ref token
// [spec RemoveGroup 2]: admin input at admin_input_index holds the user (222) token
// [spec RemoveGroup 3]: member_count == 0 — cannot deactivate group with members
// [security        4]: ADA must not decrease from input to output
// [security        5]: exact datum equality — only is_active flips to False;
//                      all other fields frozen to prevent the "deactivate + quietly
//                      change fees" attack where an admin could retroactively alter
//                      group terms at the moment of shutdown
pub fn validate_remove_group(
  policy_id: PolicyId,
  group_ref_token_name: AssetName,
  admin_input_index: Int,
  group_input_index: Int,
  group_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
) -> Bool {
  // 1. Find Group Input
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  // 2. Validate Admin Authorization
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let user_token_name =
    cip68.prefix_222
      |> bytearray.concat(
          bytearray.drop(group_ref_token_name, cip68.prefix_length),
        )
  expect
    assets.quantity_of(admin_input.output.value, policy_id, user_token_name) == 1

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current_datum: GroupDatum = input_datum_data

  // [spec RemoveGroup 3]: can only deactivate if no members remain
  let is_safe_remove = current_datum.member_count == 0

  // 3. Validate Group Output
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated_datum: GroupDatum = output_datum_data

  // [security 4]: ADA preservation
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security 5]: structural equality — only is_active changes, everything else frozen
  let expected_output_datum = GroupDatum { ..current_datum, is_active: False }

  // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
  let output_clean_value =
    assets.policies(group_output.value) == [ada_policy_id, policy_id]

  and {
    (group_output.address == group_input.output.address)?,
    (assets.quantity_of(group_output.value, policy_id, group_ref_token_name) == 1)?,
    output_clean_value?,
    is_safe_remove?,
    (updated_datum == expected_output_datum)?,
    (out_ada >= in_ada)?,
  }
}

// validate_member_join
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check (group_input_index resolves to the UTxO being spent)
//       is enforced at the entry point before this function is called.
//
// [spec MemberJoin 1]: group input holds the ref token
// [spec MemberJoin 2]: treasury is minting exactly 1 token under treasury_policy_id
//                      — proves JoinGroup ran in the same tx; prevents standalone
//                      MemberJoin calls that would inflate member_count without a
//                      corresponding treasury UTxO being created
// [spec MemberJoin 3]: group output is at the same script address with ref token
// [spec MemberJoin 4]: only member_count changes — increments by exactly 1;
//                      all other fields are structurally identical to the input datum
pub fn validate_member_join(
  policy_id: PolicyId,
  treasury_policy_id: PolicyId,
  group_ref_token_name: AssetName,
  group_input_index: Int,
  group_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  // [spec MemberJoin 1]: group input holds the ref token
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current: GroupDatum = input_datum_data

  // [spec MemberJoin 3]: group output at script address with ref token
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated: GroupDatum = output_datum_data

  // [spec MemberJoin 2]: treasury minting exactly 1 token proves JoinGroup ran
  let treasury_minting = dict.size(assets.tokens(mint, treasury_policy_id)) == 1

  // [spec MemberJoin 4]: only member_count increments; all other fields unchanged
  let expected =
    GroupDatum { ..current, member_count: current.member_count + 1 }

  // [security]: ADA must not decrease — member cannot drain group UTxO during join
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
  let output_clean_value =
    assets.policies(group_output.value) == [ada_policy_id, policy_id]

  and {
    treasury_minting?,
    (group_output.address == group_input.output.address)?,
    (assets.quantity_of(group_output.value, policy_id, group_ref_token_name) == 1)?,
    output_clean_value?,
    (updated == expected)?,
    (out_ada >= in_ada)?,
  }
}

// validate_member_exit
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check enforced at entry point.
//
// Covers all exit scenarios — member_count ALWAYS decrements:
//   1. Mature/inactive ExitGroup (burn path): token burned, slot freed immediately
//   2. Early ExitGroup (penalty path): token moves to PenaltyState, slot freed immediately
//      TerminateGroup later burns the penalty token; it does NOT touch group state.
//
// Decrementing immediately on early exit prevents one member from stalling the
// group's rotation until an admin resolves the penalty.
//
// [spec MemberExit 1]: group input holds the ref token
// [spec MemberExit 2]: member_count always decrements by exactly 1
// [spec MemberExit 3]: member_count >= 1 before exit (cannot go below 0)
// [spec MemberExit 4]: group output at same script address with ref token
// [spec MemberExit 5]: only member_count may change; all other fields frozen
pub fn validate_member_exit(
  policy_id: PolicyId,
  group_ref_token_name: AssetName,
  group_input_index: Int,
  group_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
) -> Bool {
  // [spec MemberExit 1]: group input holds the ref token
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current: GroupDatum = input_datum_data

  // [spec MemberExit 3]: member_count must be >= 1 before decrement
  expect current.member_count >= 1

  // [spec MemberExit 4]: group output at script address with ref token
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated: GroupDatum = output_datum_data

  // [spec MemberExit 2 & 5]: member_count decrements by 1; all other fields frozen
  let expected =
    GroupDatum { ..current, member_count: current.member_count - 1 }

  // [security]: ADA must not decrease — member cannot drain group UTxO during exit
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
  let output_clean_value =
    assets.policies(group_output.value) == [ada_policy_id, policy_id]

  and {
    (group_output.address == group_input.output.address)?,
    (assets.quantity_of(group_output.value, policy_id, group_ref_token_name) == 1)?,
    output_clean_value?,
    (updated == expected)?,
    (out_ada >= in_ada)?,
  }
}
