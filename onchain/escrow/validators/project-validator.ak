use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use escrow/project_validation.{
  only_own_project_input, validate_burn_project, validate_close_project,
  validate_create_project, validate_update_project,
}
use escrow/types_v2.{
  BurnProject, CloseProject, CreateProject, ProjectDatum, ProjectMintRedeemer,
  ProjectSpendRedeemer, UpdateProject,
}

validator project_validator {
  mint(redeemer: ProjectMintRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, outputs, mint, .. } = tx

    when redeemer is {
      CreateProject { seed_input_index, project_output_index } ->
        validate_create_project(
          policy_id,
          seed_input_index,
          project_output_index,
          inputs,
          outputs,
          mint,
        )
      BurnProject -> validate_burn_project(policy_id, mint)
    }
  }

  spend(
    datum: Option<ProjectDatum>,
    redeemer: ProjectSpendRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, mint, .. } = self

    // [security]: datum must be present — guards against datum-less injection.
    expect Some(project_datum) = datum

    when redeemer is {
      UpdateProject { project_input_index, continuation_index } -> {
        // [security]: self-reference — the indexed input must be the spent UTxO.
        expect Some(own_input) = list.at(inputs, project_input_index)
        expect own_input.output_reference == utxo
        expect Script(policy_id) = own_input.output.address.payment_credential

        only_own_project_input(policy_id, inputs) && validate_update_project(
          policy_id,
          project_datum,
          own_input,
          continuation_index,
          outputs,
          self,
        )
      }

      CloseProject { project_input_index } -> {
        // [security]: self-reference — the indexed input must be the spent UTxO.
        expect Some(own_input) = list.at(inputs, project_input_index)
        expect own_input.output_reference == utxo
        expect Script(policy_id) = own_input.output.address.payment_credential

        only_own_project_input(policy_id, inputs) && validate_close_project(
          policy_id,
          project_datum,
          own_input,
          mint,
          self,
        )
      }
    }
  }

  // [security]: else branch must fail — no staking withdrawals, certificates,
  // or governance actions from the project script.
  else(_) {
    fail
  }
}
