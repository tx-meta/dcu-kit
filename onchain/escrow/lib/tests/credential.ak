use aiken/collection/list
use cardano/address.{Script, VerificationKey}
use cardano/address as addr
use cardano/assets
use cardano/transaction.{Input, NoDatum, Output, OutputReference, Transaction,
  placeholder}
use escrow/credential.{credential_authorized, state_token_name}

fn test_pkh() {
  #"a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babb"
}

fn test_script_hash() {
  #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
}

fn dust_output(address: addr.Address) -> Output {
  Output {
    address,
    value: assets.from_lovelace(2_000_000),
    datum: NoDatum,
    reference_script: None,
  }
}

fn dust_input(address: addr.Address, tx_ix: Int) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
      output_index: tx_ix,
    },
    output: dust_output(address),
  }
}

test credential_authorized__vk_signature_present() {
  let tx = Transaction { ..placeholder, extra_signatories: [test_pkh()] }
  credential_authorized(VerificationKey(test_pkh()), tx)
}

test credential_authorized__vk_signature_absent() {
  let tx = placeholder
  !credential_authorized(VerificationKey(test_pkh()), tx)
}

test credential_authorized__script_spent_input_present() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [dust_input(addr.from_script(test_script_hash()), 0)],
    }
  credential_authorized(Script(test_script_hash()), tx)
}

test credential_authorized__script_no_input_at_script() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [dust_input(addr.from_verification_key(test_pkh()), 0)],
    }
  !credential_authorized(Script(test_script_hash()), tx)
}

// The script hash appearing only as a STAKE credential of a spent input must not
// authorize — only the payment credential forces the script to validate.
test credential_authorized__script_stake_credential_does_not_authorize() {
  let address =
    addr.from_verification_key(test_pkh())
      |> addr.with_delegation_script(test_script_hash())
  let tx = Transaction { ..placeholder, inputs: [dust_input(address, 0)] }
  !credential_authorized(Script(test_script_hash()), tx)
}

// Reference inputs are not spent — they must not authorize a script credential.
test credential_authorized__script_reference_input_does_not_authorize() {
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [dust_input(addr.from_script(test_script_hash()), 0)],
    }
  !credential_authorized(Script(test_script_hash()), tx)
}

test state_token_name__deterministic() {
  let ref =
    OutputReference {
      transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
      output_index: 3,
    }
  state_token_name(ref) == state_token_name(ref)
}

test state_token_name__distinct_refs_distinct_names() {
  let ref_a =
    OutputReference {
      transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
      output_index: 0,
    }
  let ref_b =
    OutputReference {
      transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
      output_index: 1,
    }
  let names = [state_token_name(ref_a), state_token_name(ref_b)]
  list.unique(names) == names
}
