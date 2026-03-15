use cardano/assets.{AssetName, PolicyId}

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
  CreateGroup
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
