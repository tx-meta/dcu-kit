use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use escrow/escrow_validation.{
  only_own_input, validate_abort, validate_burn_escrow, validate_create_escrow,
  validate_reclaim, validate_release,
}
use escrow/types.{
  Abort, BurnEscrow, CreateEscrow, EscrowDatum, EscrowMintRedeemer,
  EscrowSpendRedeemer, Reclaim, Release,
}

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

  spend(
    datum: Option<EscrowDatum>,
    redeemer: EscrowSpendRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, mint, .. } = self

    // [security]: datum must be present — guards against datum-less UTxO injection
    expect Some(escrow_datum) = datum

    when redeemer is {
      Release { escrow_input_index, continuation_index, payout_index } -> {
        // [security]: self-reference — the indexed input must be the UTxO being spent
        expect Some(own_input) = list.at(inputs, escrow_input_index)
        expect own_input.output_reference == utxo
        expect Script(policy_id) = own_input.output.address.payment_credential

        only_own_input(policy_id, inputs) && validate_release(
          policy_id,
          escrow_datum,
          own_input,
          continuation_index,
          payout_index,
          outputs,
          mint,
          self,
        )
      }

      Reclaim { escrow_input_index, refund_index } -> {
        // [security]: self-reference — the indexed input must be the UTxO being spent
        expect Some(own_input) = list.at(inputs, escrow_input_index)
        expect own_input.output_reference == utxo
        expect Script(policy_id) = own_input.output.address.payment_credential

        only_own_input(policy_id, inputs) && validate_reclaim(
          policy_id,
          escrow_datum,
          own_input,
          refund_index,
          outputs,
          mint,
          self,
        )
      }

      Abort { escrow_input_index } -> {
        // [security]: self-reference — the indexed input must be the UTxO being spent
        expect Some(own_input) = list.at(inputs, escrow_input_index)
        expect own_input.output_reference == utxo
        expect Script(policy_id) = own_input.output.address.payment_credential

        only_own_input(policy_id, inputs) && validate_abort(
          policy_id,
          escrow_datum,
          own_input,
          mint,
          self,
        )
      }
    }
  }

  // [security]: else branch must fail — no staking withdrawals, certificates, or
  // governance actions from the escrow script.
  else(_) {
    fail
  }
}
