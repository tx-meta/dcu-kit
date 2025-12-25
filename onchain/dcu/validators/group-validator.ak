use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use dcu/group.{
  CreateGroup, GroupDatum, GroupMintRedeemer, GroupSpendRedeemer, RemoveGroup,
  UpdateGroup, validate_create_group, validate_remove_group,
  validate_update_group,
}

validator group_validator {
  mint(redeemer: GroupMintRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, outputs, mint, .. } = tx

    let CreateGroup { input_index, output_index } = redeemer
    validate_create_group(
      policy_id,
      input_index,
      output_index,
      inputs,
      outputs,
      mint,
    )
  }

  spend(
    _datum: Option<GroupDatum>,
    redeemer: GroupSpendRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, .. } = self

    // Extract own PolicyId from the input being spent
    expect Some(own_input) =
      list.find(inputs, fn(i) { i.output_reference == utxo })
    expect Script(policy_id) = own_input.output.address.payment_credential

    when redeemer is {
      UpdateGroup {
        group_ref_token_name,
        admin_input_index,
        group_input_index,
        group_output_index,
      } ->

        validate_update_group(
          policy_id,
          group_ref_token_name,
          admin_input_index,
          group_input_index,
          group_output_index,
          inputs,
          outputs,
        )

      RemoveGroup {
        group_ref_token_name,
        admin_input_index,
        group_input_index,
        group_output_index,
      } ->

        validate_remove_group(
          policy_id,
          group_ref_token_name,
          admin_input_index,
          group_input_index,
          group_output_index,
          inputs,
          outputs,
        )
    }
  }

  else(_) {
    trace @"Group Validator - Fallback"
    True
  }
}
