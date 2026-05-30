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
  let grace_period_length <- fuzz.and_then(fuzz.int())
  let creator_bond <- fuzz.and_then(fuzz.int())
  let interval_length <- fuzz.and_then(fuzz.int())
  let num_rounds <- fuzz.and_then(fuzz.int())
  let max_members <- fuzz.and_then(fuzz.int())
  let member_count <- fuzz.and_then(fuzz.int())
  let is_active <- fuzz.and_then(fuzz.bool())
  let is_started <- fuzz.and_then(fuzz.bool())
  let start_time <- fuzz.and_then(fuzz.int())
  let last_distributed_round <- fuzz.and_then(fuzz.int())
  let creator_payment_credential <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let collateral_rounds <- fuzz.and_then(fuzz.int())

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
      grace_period_length,
      creator_bond,
      interval_length,
      num_rounds,
      max_members,
      member_count,
      is_active,
      is_started,
      start_time,
      last_distributed_round,
      creator_payment_credential,
      member_token_names: [],
      collateral_rounds,
    },
  )
}

// --- Constrained VALID Group Datum Fuzzer ---
// Produces a GroupDatum that satisfies EVERY datum-level rule in validate_create_group,
// while randomising the fields that are free to vary within their valid ranges. The
// creation-invariant fields (num_rounds, member_count, is_active, is_started, start_time,
// last_distributed_round, member_token_names) are pinned to their only valid values so the
// "accept" branch of the create-group property test is exercised on every run.
pub fn gen_valid_group_datum() {
  let contribution_fee <- fuzz.and_then(fuzz.int_at_least(1))
  let contribution_fee_policyid <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let contribution_fee_assetname <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let joining_fee <- fuzz.and_then(fuzz.int_at_least(0))
  let joining_fee_policyid <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let joining_fee_assetname <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let penalty_fee <- fuzz.and_then(fuzz.int_at_least(0))
  let penalty_fee_policyid <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let penalty_fee_assetname <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let grace_period_length <- fuzz.and_then(fuzz.int_at_least(0))
  let creator_bond <- fuzz.and_then(fuzz.int_at_least(0))
  let interval_length <- fuzz.and_then(fuzz.int_at_least(1))
  let max_members <- fuzz.and_then(fuzz.int_at_least(1))
  let collateral_rounds <- fuzz.and_then(fuzz.int_between(1, max_members))
  let creator_payment_credential <- fuzz.and_then(fuzz.bytearray_fixed(28))

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
      grace_period_length,
      creator_bond,
      interval_length,
      // creation invariants — only valid values
      num_rounds: 0,
      max_members,
      member_count: 0,
      is_active: True,
      is_started: False,
      start_time: 0,
      last_distributed_round: -1,
      creator_payment_credential,
      member_token_names: [],
      collateral_rounds,
    },
  )
}

// --- Account Datum Fuzzer ---

pub fn gen_account_datum() {
  let display_name <- fuzz.and_then(fuzz.bytearray())
  let contact <- fuzz.and_then(fuzz.bytearray())

  fuzz.constant(AccountDatum { display_name, contact })
}
