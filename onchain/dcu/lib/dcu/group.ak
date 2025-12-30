use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId, Value}
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
  share_holding: Bool,
  is_active: Bool,
}

/// Group Validator Redeemer
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
}

pub fn validate_create_group(
  policy_id: PolicyId,
  input_index: Int,
  output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  // Find output with GroupDatum
  expect Some(output) = list.at(outputs, output_index)
  expect InlineDatum(d) = output.datum
  expect datum: GroupDatum = d

  // CIP-68 Verification
  // Retrieve input at input_index
  expect Some(params_input) = list.at(inputs, input_index)

  // Use utility to generate correct unique token names (handles 32-byte limit)
  let ref_token_name =
    cip68.unique_token_name(params_input.output_reference, cip68.prefix_100)
  let user_token_name =
    cip68.unique_token_name(params_input.output_reference, cip68.prefix_222)

  let minted_tokens = assets.tokens(mint, policy_id)
  expect Some(1) = dict.get(minted_tokens, ref_token_name)
  expect Some(1) = dict.get(minted_tokens, user_token_name)
  let exact_mint_quantity = dict.size(minted_tokens) == 2

  // Validate output destination and value
  let output_at_script_address =
    output.address.payment_credential == Script(policy_id)

  let output_has_ref_token =
    assets.quantity_of(output.value, policy_id, ref_token_name) == 1

  // Validation:
  and {
    exact_mint_quantity?,
    output_at_script_address?,
    output_has_ref_token?,
    (datum.contribution_fee > 0)?,
    (datum.joining_fee >= 0)?,
    (datum.penalty_fee >= 0)?,
    (datum.interval_length > 0)?,
    (datum.num_intervals > 0)?,
    (datum.member_count == 0)?,
    datum.is_active?,
  }
}

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
  // Ensure it's the correct Group UTxO by checking the Reference Token
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  // 2. Validate Admin Authorization
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  // Calculate user token name: drop (100) prefix, replace with (222) prefix 
  let user_token_name =
    cip68.prefix_222
      |> bytearray.concat(
          bytearray.drop(group_ref_token_name, cip68.prefix_length),
        )

  // Admin must hold the User Token (prefix_222) corresponding to the thread
  expect
    assets.quantity_of(admin_input.output.value, policy_id, user_token_name) == 1

  // 3. Validate Group Output
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(datum_data) = group_output.datum
  expect updated_datum: GroupDatum = datum_data

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current_datum: GroupDatum = input_datum_data

  // 4. Security Checks
  // Critical Check: Can only change fees/intervals if member_count is 0.
  // This prevents rug-pulling existing members.
  let is_critical_update =
    updated_datum.contribution_fee != current_datum.contribution_fee || updated_datum.joining_fee != current_datum.joining_fee || updated_datum.penalty_fee != current_datum.penalty_fee || updated_datum.interval_length != current_datum.interval_length || updated_datum.num_intervals != current_datum.num_intervals

  let is_safe_update = !is_critical_update || current_datum.member_count == 0

  // 5. Constraints
  and {
    // Must strictly send to script address
    (group_output.address == group_input.output.address)?,
    // Must preserve the Reference Token
    (assets.quantity_of(group_output.value, policy_id, group_ref_token_name) == 1)?,
    // Admin checks
    is_safe_update?,
    // Members count must be preserved (Updates don't change membership)
    (updated_datum.member_count == current_datum.member_count)?,
    // Active status logic (use RemoveGroup to deactivate)
    updated_datum.is_active?,
  }
}

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
  // Ensure it's the correct Group UTxO by checking the Reference Token
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  // 2. Validate Admin Authorization
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  // Calculate user token name: drop (100) prefix, replace with (222) prefix 
  let user_token_name =
    cip68.prefix_222
      |> bytearray.concat(
          bytearray.drop(group_ref_token_name, cip68.prefix_length),
        )

  // Admin must hold the User Token (prefix_222) corresponding to the thread
  expect
    assets.quantity_of(admin_input.output.value, policy_id, user_token_name) == 1

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current_datum: GroupDatum = input_datum_data

  // 3. Validate Group Output
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated_datum: GroupDatum = output_datum_data

  // 4. Security Checks
  // Can only remove if member_count is 0.
  let is_safe_remove = current_datum.member_count == 0

  // 5. Constraints
  and {
    // Must strictly send to script address
    (group_output.address == group_input.output.address)?,
    // Must preserve the Reference Token
    (assets.quantity_of(group_output.value, policy_id, group_ref_token_name) == 1)?,
    // Admin checks
    is_safe_remove?,
    // Correct status update
    !updated_datum.is_active?,
    // Ensure 0 members
    (updated_datum.member_count == 0)?,
  }
}
