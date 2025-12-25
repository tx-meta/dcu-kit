use aiken/collection/dict
use aiken/collection/list
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
pub type GroupRedeemer {
  CreateGroup { input_index: Int, output_index: Int }
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

