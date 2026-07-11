use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}
use escrow/escrow_v2_validation.{only_own_input}
use escrow/pool_validation.{
  validate_allocate, validate_burn_pool, validate_close_pool,
  validate_create_pool, validate_exit_deposit, validate_update_pool,
}
use escrow/types_pool.{
  AllocateToEscrow, BurnPool, ClosePool, CreatePool, ExitDeposit, PoolAnchor,
  PoolDeposit, PoolMintRedeemer, PoolSpendRedeemer, UpdatePool, VaultDatum,
}

// [security]: self-reference — the indexed input must be the UTxO being spent.
fn own(
  inputs: List<Input>,
  ix: Int,
  utxo: OutputReference,
) -> (Input, PolicyId) {
  expect Some(own_input) = list.at(inputs, ix)
  expect own_input.output_reference == utxo
  expect Script(policy_id) = own_input.output.address.payment_credential
  (own_input, policy_id)
}

validator pool_vault {
  mint(redeemer: PoolMintRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, outputs, mint, .. } = tx

    when redeemer is {
      CreatePool { seed_input_index, pool_output_index } ->
        validate_create_pool(
          policy_id,
          seed_input_index,
          pool_output_index,
          inputs,
          outputs,
          mint,
        )
      BurnPool -> validate_burn_pool(policy_id, mint)
    }
  }

  spend(
    datum: Option<VaultDatum>,
    redeemer: PoolSpendRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, reference_inputs, outputs, mint, .. } = self

    // [security]: datum must be present — guards against datum-less injection.
    expect Some(vault_datum) = datum

    when redeemer is {
      UpdatePool { pool_input_index, continuation_index } -> {
        let (own_input, policy_id) = own(inputs, pool_input_index, utxo)
        expect PoolAnchor { pool } = vault_datum
        only_own_input(policy_id, inputs) && validate_update_pool(
          policy_id,
          pool,
          own_input,
          continuation_index,
          outputs,
          self,
        )
      }

      ClosePool { pool_input_index } -> {
        let (own_input, policy_id) = own(inputs, pool_input_index, utxo)
        expect PoolAnchor { pool } = vault_datum
        only_own_input(policy_id, inputs) && validate_close_pool(
          policy_id,
          pool,
          own_input,
          mint,
          self,
        )
      }

      ExitDeposit { deposit_input_index } -> {
        let (_own_input, policy_id) = own(inputs, deposit_input_index, utxo)
        expect PoolDeposit { contributor, locked_until, .. } = vault_datum
        only_own_input(policy_id, inputs) && validate_exit_deposit(
          contributor,
          locked_until,
          self,
        )
      }

      AllocateToEscrow {
        deposit_input_index,
        pool_ref_index,
        escrow_output_index,
        escrow_input_index,
        continuation_index,
      } -> {
        let (own_input, policy_id) = own(inputs, deposit_input_index, utxo)
        expect PoolDeposit { pool_id, .. } = vault_datum
        expect InlineDatum(own_raw) = own_input.output.datum
        only_own_input(policy_id, inputs) && validate_allocate(
          policy_id,
          own_raw,
          pool_id,
          own_input,
          pool_ref_index,
          escrow_output_index,
          escrow_input_index,
          continuation_index,
          inputs,
          reference_inputs,
          outputs,
          self,
        )
      }
    }
  }

  // [security]: else branch must fail — no staking withdrawals, certificates,
  // or governance actions from the vault script.
  else(_) {
    fail
  }
}
