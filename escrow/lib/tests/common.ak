use cardano/address.{Address, VerificationKey}
use cardano/address as addr
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, OutputReference}
use escrow/credential.{state_token_name}
use escrow/types.{EscrowDatum}

pub fn escrow_policy() -> PolicyId {
  #"e5c40e5c40e5c40e5c40e5c40e5c40e5c40e5c40e5c40e5c40e5c40e"
}

pub fn funder_pkh() {
  #"f0f1f2f3f4f5f6f7f8f9fafbfcfdfef0f1f2f3f4f5f6f7f8f9fafbfc"
}

pub fn beneficiary_pkh() {
  #"b0b1b2b3b4b5b6b7b8b9babbbcbdbebfb0b1b2b3b4b5b6b7b8b9babb"
}

pub fn verifier_pkh() {
  #"a0a1a2a3a4a5a6a7a8a9aaabacadaeafa0a1a2a3a4a5a6a7a8a9aaab"
}

pub fn stake_pkh() {
  #"50755075507550755075507550755075507550755075507550755075"
}

pub fn token_policy() -> PolicyId {
  #"10710710710710710710710710710710710710710710710710710710"
}

pub fn funder_address() -> Address {
  addr.from_verification_key(funder_pkh())
    |> addr.with_delegation_key(stake_pkh())
}

pub fn beneficiary_address() -> Address {
  addr.from_verification_key(beneficiary_pkh())
    |> addr.with_delegation_key(stake_pkh())
}

pub fn escrow_address(policy_id: PolicyId) -> Address {
  addr.from_script(policy_id)
}

pub fn seed_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed",
    output_index: 0,
  }
}

pub fn seed_input() -> Input {
  Input {
    output_reference: seed_ref(),
    output: Output {
      address: funder_address(),
      value: assets.from_lovelace(200_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

pub fn seed_token_name() {
  state_token_name(seed_ref())
}

// Default: ADA escrow, three tranches (retention-shaped: last is the holdback).
pub fn test_escrow_datum() -> EscrowDatum {
  EscrowDatum {
    funder: funder_address(),
    beneficiary: beneficiary_address(),
    verifier: VerificationKey(verifier_pkh()),
    asset_policy: assets.ada_policy_id,
    asset_name: assets.ada_asset_name,
    milestones: [40_000_000, 40_000_000, 20_000_000],
    released_count: 0,
    expiry: 1_800_000_000_000,
  }
}

pub fn escrow_output(
  policy_id: PolicyId,
  datum: EscrowDatum,
  value: Value,
) -> Output {
  let data: Data = datum
  Output {
    address: escrow_address(policy_id),
    value,
    datum: InlineDatum(data),
    reference_script: None,
  }
}

pub fn escrow_utxo_value(policy_id: PolicyId, lovelace: Int) -> Value {
  assets.from_lovelace(lovelace)
    |> assets.add(policy_id, seed_token_name(), 1)
}

pub fn user_output(address: Address, value: Value) -> Output {
  Output { address, value, datum: NoDatum, reference_script: None }
}

pub fn escrow_input(ix: Int, output: Output) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"ecec0ecec0ecec0ecec0ecec0ecec0ecec0ecec0ecec0ecec0ecec0ecec0ecec",
      output_index: ix,
    },
    output,
  }
}
