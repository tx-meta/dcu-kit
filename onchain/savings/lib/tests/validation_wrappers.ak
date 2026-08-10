// Test-only adapters that synthesize a matching intent for pre-intent unit
// fixtures. Production modules expose and validators call only `*_bound`.
use aiken/collection/list
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, Transaction}
use savings/types.{SavingsDatum, SavingsFund}
use savings/validation.{
  asset_amount, close_cycle_intent_hash, close_fund_intent_hash,
  datum_intent_hash, fund_name_of, min_ada_buffer, own_tokens,
  social_payout_intent_hash, update_fund_intent_hash, validate_close_cycle_bound,
  validate_close_fund_bound, validate_disburse_loan_bound,
  validate_social_payout_bound, validate_update_fund_bound,
  validate_write_off_loan_bound, write_off_intent_hash,
}

fn output_datum(output: Output) -> SavingsDatum {
  expect InlineDatum(raw) = output.datum
  expect datum: SavingsDatum = raw
  datum
}

pub fn validate_social_payout(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  fund_output_index: Int,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect SavingsFund { asset_policy, asset_name, .. } = datum
  expect Some(fund_out) = list.at(outputs, fund_output_index)
  let paid = asset_amount(own_input.output.value, asset_policy, asset_name) - asset_amount(
    fund_out.value,
    asset_policy,
    asset_name,
  )
  let payout_value = if asset_policy == "" {
    assets.from_lovelace(paid)
  } else {
    assets.merge(
      assets.from_lovelace(min_ada_buffer),
      assets.from_asset(asset_policy, asset_name, paid),
    )
  }
  let payout_out = Output {
    address: own_input.output.address,
    value: payout_value,
    datum: NoDatum,
    reference_script: None,
  }
  validate_social_payout_bound(
    policy_id,
    datum,
    own_input,
    social_payout_intent_hash(payout_out.address, paid),
    fund_output_index,
    list.length(outputs),
    list.concat(outputs, [payout_out]),
    mint,
    tx,
  )
}

pub fn validate_update_fund(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  fund_output_index: Int,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect Some(fund_out) = list.at(outputs, fund_output_index)
  expect  
      SavingsFund {
        title,
        quorum,
        min_shares_per_deposit,
        max_shares_per_deposit,
        max_loan_multiple,
        loan_grace,
        cycle_end,
        ..
      }
    = output_datum(fund_out)
  validate_update_fund_bound(
    policy_id,
    datum,
    own_input,
    update_fund_intent_hash(
      title,
      quorum,
      min_shares_per_deposit,
      max_shares_per_deposit,
      max_loan_multiple,
      loan_grace,
      cycle_end,
    ),
    fund_output_index,
    outputs,
    mint,
    tx,
  )
}

pub fn validate_close_cycle(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  fund_output_index: Int,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  validate_close_cycle_bound(
    policy_id,
    datum,
    own_input,
    close_cycle_intent_hash(),
    fund_output_index,
    outputs,
    mint,
    tx,
  )
}

pub fn validate_close_fund(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  mint: Value,
  tx: Transaction,
) -> Bool {
  let fund_name = fund_name_of(own_input, policy_id)
  let payout_out = Output {
    address: own_input.output.address,
    value: assets.merge(
      own_input.output.value,
      assets.from_asset(policy_id, fund_name, -1),
    ),
    datum: NoDatum,
    reference_script: None,
  }
  validate_close_fund_bound(
    policy_id,
    datum,
    own_input,
    close_fund_intent_hash(payout_out.address),
    0,
    [payout_out],
    mint,
    tx,
  )
}

pub fn validate_disburse_loan(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  member_input_index: Int,
  seed_input_index: Int,
  fund_output_index: Int,
  member_output_index: Int,
  loan_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect Some(loan_out) = list.at(outputs, loan_output_index)
  validate_disburse_loan_bound(
    policy_id,
    datum,
    own_input,
    datum_intent_hash(output_datum(loan_out)),
    member_input_index,
    seed_input_index,
    fund_output_index,
    member_output_index,
    loan_output_index,
    inputs,
    outputs,
    mint,
    tx,
  )
}

pub fn validate_write_off_loan(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  member_input_index: Int,
  loan_input_index: Int,
  fund_output_index: Int,
  member_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect Some(loan_input) = list.at(inputs, loan_input_index)
  expect [Pair(loan_name, 1)] = own_tokens(loan_input.output.value, policy_id)
  validate_write_off_loan_bound(
    policy_id,
    datum,
    own_input,
    write_off_intent_hash(loan_name),
    member_input_index,
    loan_input_index,
    fund_output_index,
    member_output_index,
    inputs,
    outputs,
    mint,
    tx,
  )
}
