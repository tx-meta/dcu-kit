use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{PolicyId, Value, zero}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, OutputReference}
use dcu/cip68
use dcu/group.{GroupDatum}

// --- Constants & Placeholders ---

pub const placeholder_output =
  Output {
    address: Address {
      payment_credential: VerificationKey(
        #"00000000000000000000000000000000000000000000000000000000",
      ),
      stake_credential: None,
    },
    value: zero,
    datum: NoDatum,
    reference_script: None,
  }

pub const placeholder_input =
  Input {
    output_reference: OutputReference {
      transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
      output_index: 0,
    },
    output: placeholder_output,
  }

// --- Hash Generators (Deterministic) ---

pub fn test_hash_01() {
  bytearray.take(blake2b_256(#"01"), 28)
}

pub fn test_hash_02() {
  bytearray.take(blake2b_256(#"02"), 28)
}

pub fn test_hash_03() {
  bytearray.take(blake2b_256(#"03"), 28)
}

pub fn test_policy_id() {
  test_hash_01()
}

pub fn test_pkh() {
  test_hash_02()
}

// --- Generic Builders ---

/// Create a standard output with a generic datum
pub fn test_output(addr: Address, value: Value, datum: Data) -> Output {
  Output {
    address: addr,
    value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

/// Create a simple input from an output reference and an output
pub fn test_input(output_ref: OutputReference, output: Output) -> Input {
  Input { output_reference: output_ref, output }
}

/// Helper to construct a UTxO specifically for a script address with a Datum
pub fn test_script_utxo(
  policy_id: PolicyId,
  value: Value,
  datum: Data,
) -> Output {
  test_output(Address(Script(policy_id), None), value, datum)
}

/// Helper to construct a UTxO for a User (Public Key Address) with NoDatum or specific datum
pub fn test_user_utxo(pkh: ByteArray, value: Value, datum: Data) -> Output {
  test_output(Address(VerificationKey(pkh), None), value, datum)
}

// --- Group Generic Helpers ---

pub fn test_group_datum(policy_id: PolicyId) -> GroupDatum {
  GroupDatum {
    contribution_fee_policyid: policy_id,
    contribution_fee_assetname: "",
    contribution_fee: 1000,
    joining_fee_policyid: policy_id,
    joining_fee_assetname: "",
    joining_fee: 100,
    penalty_fee_policyid: #"",
    penalty_fee_assetname: "",
    penalty_fee: 100,
    grace_period_length: 0,
    creator_bond: 0,
    interval_length: 1000,
    // num_intervals = 0 before startGroup; tests that need active rotation
    // should set num_intervals explicitly via record update syntax
    num_intervals: 0,
    max_members: 30,
    member_count: 0,
    is_active: True,
    // is_started = False at creation; tests simulating post-startGroup state
    // should set is_started = True and num_intervals = member_count explicitly
    is_started: False,
    // start_time = 0; tests simulating active cycle should set this explicitly
    start_time: 0,
    last_distributed_round: -1,
    admin_payment_credential: test_pkh(),
    member_token_names: [],
  }
}

pub fn setup_cip68(
  _policy_id: PolicyId,
) -> (OutputReference, ByteArray, ByteArray) {
  let tx_id =
    #"0000000000000000000000000000000000000000000000000000000000000000"
  let output_ref = OutputReference { transaction_id: tx_id, output_index: 0 }
  let ref_tn = cip68.unique_token_name(output_ref, cip68.prefix_100)
  let user_tn = cip68.unique_token_name(output_ref, cip68.prefix_222)
  (output_ref, ref_tn, user_tn)
}
