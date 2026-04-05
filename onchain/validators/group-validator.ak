use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use dcu/group.{
  CreateGroup, GroupDatum, GroupMintRedeemer, GroupSpendRedeemer, MemberExit,
  MemberJoin, RemoveGroup, UpdateGroup, validate_create_group,
  validate_member_exit, validate_member_join, validate_remove_group,
  validate_update_group,
}

validator group_validator(treasury_policy_id: PolicyId) {
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
    datum: Option<GroupDatum>,
    redeemer: GroupSpendRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, .. } = self

    // [security]: datum must be present — guards against datum-less UTxO injection
    expect Some(_) = datum

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
      } -> {
        // [security]: self-reference — group_input_index must resolve to the UTxO
        // being spent, preventing cross-UTxO attacks that bypass member_count == 0.
        expect Some(group_input) = list.at(inputs, group_input_index)
        expect group_input.output_reference == utxo

        validate_update_group(
          policy_id,
          group_ref_token_name,
          admin_input_index,
          group_input_index,
          group_output_index,
          inputs,
          outputs,
        )
      }

      RemoveGroup {
        group_ref_token_name,
        admin_input_index,
        group_input_index,
        group_output_index,
      } -> {
        // [security]: self-reference — same pattern as UpdateGroup above
        expect Some(group_input) = list.at(inputs, group_input_index)
        expect group_input.output_reference == utxo

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

      MemberJoin { group_ref_token_name, group_input_index, group_output_index } -> {
        // [security]: self-reference — group_input_index must resolve to this UTxO
        expect Some(group_input) = list.at(inputs, group_input_index)
        expect group_input.output_reference == utxo

        validate_member_join(
          policy_id,
          treasury_policy_id,
          group_ref_token_name,
          group_input_index,
          group_output_index,
          inputs,
          outputs,
          self.mint,
        )
      }

      MemberExit { group_ref_token_name, group_input_index, group_output_index } -> {
        // [security]: self-reference — same pattern as above
        expect Some(group_input) = list.at(inputs, group_input_index)
        expect group_input.output_reference == utxo

        validate_member_exit(
          policy_id,
          treasury_policy_id,
          group_ref_token_name,
          group_input_index,
          group_output_index,
          inputs,
          outputs,
          self.mint,
        )
      }
    }
  }

  // [security]: else branch must fail — prevents unauthorized staking withdrawals
  // and governance votes from the group's script address.
  else(_) {
    fail
  }
}
