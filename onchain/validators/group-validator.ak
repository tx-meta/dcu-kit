use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use dcu/group.{
  BurnGroup, CloseGroup, CreateGroup, Distribute, Exit, GroupCip68Datum,
  GroupMintRedeemer, GroupSpendRedeemer, Join, Recover, RecoverMember,
  StartGroup, UpdateGroup, validate_close_group, validate_create_group,
  validate_distribute_group, validate_exit_group, validate_join_group,
  validate_recover_group, validate_start_group, validate_update_group,
}

validator group_validator(treasury_policy_id: PolicyId) {
  mint(redeemer: GroupMintRedeemer, policy_id: PolicyId, tx: Transaction) {
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
      // [security]: BurnGroup — spend handler (RemoveGroup) validates admin auth and
      // member_count == 0. Here we verify: (a) all quantities are negative (no new mint),
      // and (b) exactly 2 tokens are burned (ref + user). Without (b), an admin could
      // burn only their user token via BurnGroup — skipping the spend handler entirely —
      // leaving the group UTxO locked on-chain with no reachable RemoveGroup path.
      BurnGroup -> {
        let burned_tokens = assets.tokens(mint, policy_id)
        dict.size(burned_tokens) == 2 && list.all(
          dict.to_pairs(burned_tokens),
          fn(pair) {
            let Pair(_, qty) = pair
            qty < 0
          },
        )
      }
    }
  }

  spend(
    datum: Option<GroupCip68Datum>,
    redeemer: GroupSpendRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, .. } = self

    // [security]: datum must be present — guards against datum-less UTxO injection
    expect Some(_) = datum

    // Extract own PolicyId from the input being spent
    expect Some(own_input) = list.find(
      inputs,
      fn(i) { i.output_reference == utxo },
    )
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

      CloseGroup { group_ref_token_name, admin_input_index, group_input_index } -> {
        // [security]: self-reference — same pattern as UpdateGroup above
        expect Some(group_input) = list.at(inputs, group_input_index)
        expect group_input.output_reference == utxo

        validate_close_group(
          policy_id,
          group_ref_token_name,
          admin_input_index,
          group_input_index,
          inputs,
          self.mint,
        )
      }

      Join {
        group_ref_token_name,
        member_token_name,
        group_input_index,
        group_output_index,
      } -> {
        // [security]: self-reference — group_input_index must resolve to this UTxO
        expect Some(group_input) = list.at(inputs, group_input_index)
        expect group_input.output_reference == utxo

        validate_join_group(
          policy_id,
          treasury_policy_id,
          group_ref_token_name,
          member_token_name,
          group_input_index,
          group_output_index,
          inputs,
          outputs,
          self.mint,
        )
      }

      Exit {
        group_ref_token_name,
        member_token_name,
        group_input_index,
        group_output_index,
      } -> {
        // [security]: self-reference — same pattern as above
        expect Some(group_input) = list.at(inputs, group_input_index)
        expect group_input.output_reference == utxo

        validate_exit_group(
          policy_id,
          treasury_policy_id,
          group_ref_token_name,
          member_token_name,
          group_input_index,
          group_output_index,
          inputs,
          outputs,
        )
      }

      StartGroup {
        group_ref_token_name,
        admin_input_index,
        group_input_index,
        group_output_index,
      } -> {
        // [security]: self-reference — group_input_index must resolve to this UTxO
        expect Some(group_input) = list.at(inputs, group_input_index)
        expect group_input.output_reference == utxo

        validate_start_group(
          policy_id,
          group_ref_token_name,
          admin_input_index,
          group_input_index,
          group_output_index,
          inputs,
          outputs,
          self,
        )
      }

      Distribute {
        group_ref_token_name,
        group_input_index,
        group_output_index,
        round_number,
      } -> {
        // [security]: self-reference — group_input_index must resolve to this UTxO
        expect Some(group_input) = list.at(inputs, group_input_index)
        expect group_input.output_reference == utxo

        validate_distribute_group(
          policy_id,
          group_ref_token_name,
          group_input_index,
          group_output_index,
          round_number,
          inputs,
          outputs,
          self,
        )
      }

      Recover {
        group_ref_token_name,
        group_input_index,
        group_output_index,
        treasury_input_index,
        treasury_output_index,
      } -> {
        // [security]: self-reference — group_input_index must resolve to this UTxO
        expect Some(group_input) = list.at(inputs, group_input_index)
        expect group_input.output_reference == utxo

        validate_recover_group(
          policy_id,
          treasury_policy_id,
          group_ref_token_name,
          group_input_index,
          group_output_index,
          treasury_input_index,
          treasury_output_index,
          inputs,
          outputs,
        )
      }

      // Lost-member recovery rotation: real validation lands in Task 2.2.
      RecoverMember { .. } -> fail
    }
  }

  // [security]: else branch must fail — prevents unauthorized staking withdrawals
  // and governance votes from the group's script address.
  else(_) {
    fail
  }
}
