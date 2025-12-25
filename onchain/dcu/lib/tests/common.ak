use cardano/address.{Address}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference}
use dcu/cip68
use dcu/group.{GroupDatum}

pub fn test_group_datum(policy_id: PolicyId) -> GroupDatum {
  GroupDatum {
    contribution_fee_policyid: policy_id,
    contribution_fee_assetname: "",
    contribution_fee: 1000,
    joining_fee_policyid: policy_id,
    joining_fee_assetname: "",
    joining_fee: 100,
    penalty_fee_policyid: policy_id,
    penalty_fee_assetname: "",
    penalty_fee: 100,
    interval_length: 1000,
    num_intervals: 10,
    member_count: 0,
    share_holding: False,
    is_active: True,
  }
}

pub fn test_output(
  addr: Address,
  value: Value,
  datum: group.GroupDatum,
) -> Output {
  Output {
    address: addr,
    value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

pub fn test_input(output_ref: OutputReference, output: Output) -> Input {
  Input { output_reference: output_ref, output }
}

pub fn test_ref_token_name(output_ref: OutputReference) -> ByteArray {
  cip68.unique_token_name(output_ref, cip68.prefix_100)
}

pub fn test_user_token_name(output_ref: OutputReference) -> ByteArray {
  cip68.unique_token_name(output_ref, cip68.prefix_222)
}

pub fn setup_cip68(
  _policy_id: PolicyId,
) -> (OutputReference, ByteArray, ByteArray) {
  let tx_id =
    #"0000000000000000000000000000000000000000000000000000000000000000"
  let output_ref = OutputReference { transaction_id: tx_id, output_index: 0 }
  let ref_tn = test_ref_token_name(output_ref)
  let user_tn = test_user_token_name(output_ref)
  (output_ref, ref_tn, user_tn)
}
