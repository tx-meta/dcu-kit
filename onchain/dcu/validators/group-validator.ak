use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use dcu/group.{GroupDatum, GroupRedeemer, CreateGroup, validate_create_group}

validator group_validator {
  mint(redeemer: GroupRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, outputs, mint, .. } = tx

    when redeemer is {
      CreateGroup { input_index, output_index } ->
        validate_create_group(
          policy_id,
          input_index,
          output_index,
          inputs,
          outputs,
          mint,
        )
      _ -> False
    }
  }

  spend(
    _datum: Option<GroupDatum>,
    _redeemer: GroupRedeemer,
    _utxo: OutputReference,
    _self: Transaction,
  ) {
    // TODO: UpdateGroup
    // - Validate Group UTxO input (group_input_index).
    // - Validate Admin input (admin_input_index) checks ownership (Reference Token logic vs User Token logic).
    // - Ensure output at group_output_index goes to script with updated Group Datum.
    // - Constraints: Critical changes (fees, intervals) only allowed if member_count == 0.
    // - Ensure Group NFT preserved in output.

    // TODO: RemoveGroup
    // - Validate Group UTxO input.
    // - Validate Admin input (ownership).
    // - Ensure output Group Datum has is_active == False.
    // - Ensure member_count == 0 before deactivation allowed.
    // - Ensure Group NFT preserved.

    trace @"Group Validator - Spend"
    True
  }

  else(_) {
    trace @"Group Validator - Fallback"
    True
  }
}
