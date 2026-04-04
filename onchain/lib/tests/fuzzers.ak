use aiken/fuzz
use dcu/account.{AccountDatum}
use dcu/group.{GroupDatum}

// --- Group Datum Fuzzer ---

pub fn gen_group_datum() {
  let contribution_fee <- fuzz.and_then(fuzz.int())
  let contribution_fee_policyid <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let contribution_fee_assetname <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let joining_fee <- fuzz.and_then(fuzz.int())
  let joining_fee_policyid <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let joining_fee_assetname <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let penalty_fee <- fuzz.and_then(fuzz.int())
  let penalty_fee_policyid <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let penalty_fee_assetname <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let interval_length <- fuzz.and_then(fuzz.int())
  let num_intervals <- fuzz.and_then(fuzz.int())
  let member_count <- fuzz.and_then(fuzz.int())
  let is_active <- fuzz.and_then(fuzz.bool())
  let start_time <- fuzz.and_then(fuzz.int())

  fuzz.constant(
    GroupDatum {
      contribution_fee_policyid,
      contribution_fee_assetname,
      contribution_fee,
      joining_fee_policyid,
      joining_fee_assetname,
      joining_fee,
      penalty_fee_policyid,
      penalty_fee_assetname,
      penalty_fee,
      interval_length,
      num_intervals,
      member_count,
      is_active,
      start_time,
    },
  )
}

// --- Account Datum Fuzzer ---

pub fn gen_account_datum() {
  let email_hash <- fuzz.and_then(fuzz.bytearray())
  let phone_hash <- fuzz.and_then(fuzz.bytearray())

  fuzz.constant(AccountDatum { email_hash, phone_hash })
}
