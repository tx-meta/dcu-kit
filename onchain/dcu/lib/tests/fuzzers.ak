use aiken/fuzz
use dcu/group.{GroupDatum}
use tests/common

// --- Group Datum Fuzzer ---

pub fn gen_group_datum() {
  let contribution_fee <- fuzz.and_then(fuzz.int())
  let joining_fee <- fuzz.and_then(fuzz.int())
  let penalty_fee <- fuzz.and_then(fuzz.int())
  let interval_length <- fuzz.and_then(fuzz.int())
  let num_intervals <- fuzz.and_then(fuzz.int())
  let member_count <- fuzz.and_then(fuzz.int())
  let is_active <- fuzz.and_then(fuzz.bool())
  
  // Use constant policy IDs for now
  let policy_id = common.test_policy_id()

  fuzz.constant(
    GroupDatum {
      contribution_fee_policyid: policy_id,
      contribution_fee_assetname: "",
      contribution_fee,
      joining_fee_policyid: policy_id,
      joining_fee_assetname: "",
      joining_fee,
      penalty_fee_policyid: policy_id,
      penalty_fee_assetname: "",
      penalty_fee,
      interval_length,
      num_intervals,
      member_count,
      share_holding: False,
      is_active,
    },
  )
}
