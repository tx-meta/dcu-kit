use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}
use escrow/escrow_validation.{validate_burn_escrow, validate_create_escrow}
use escrow/types.{BurnEscrow, CreateEscrow, EscrowMintRedeemer}

validator escrow_validator {
  mint(redeemer: EscrowMintRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, outputs, mint, .. } = tx

    when redeemer is {
      CreateEscrow { seed_input_index, escrow_output_index } ->
        validate_create_escrow(
          policy_id,
          seed_input_index,
          escrow_output_index,
          inputs,
          outputs,
          mint,
        )
      BurnEscrow -> validate_burn_escrow(policy_id, mint)
    }
  }

  // [security]: else branch must fail — no staking withdrawals, certificates, or
  // governance actions from the escrow script.
  else(_) {
    fail
  }
}
