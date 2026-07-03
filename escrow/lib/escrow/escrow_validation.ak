use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/assets.{PolicyId, Value}
use cardano/address.{Script, VerificationKey}
use cardano/transaction.{InlineDatum, Input, Output}
use escrow/credential.{state_token_name}
use escrow/types.{EscrowDatum}

fn credential_hash_valid(cred) {
  when cred is {
    VerificationKey(h) -> bytearray.length(h) == 28
    Script(h) -> bytearray.length(h) == 28
  }
}

pub fn milestones_total(milestones: List<Int>) -> Int {
  list.foldl(milestones, 0, fn(m, acc) { m + acc })
}

// [spec 3.3]: one-shot state token — exactly one token of this policy minted, name
// derived from the spent seed input; escrow output at the validator's own address
// with the token and a well-formed initial datum.
pub fn validate_create_escrow(
  policy_id: PolicyId,
  seed_input_index: Int,
  escrow_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  expect Some(seed) = list.at(inputs, seed_input_index)
  let name = state_token_name(seed.output_reference)
  expect [Pair(minted_name, 1)] = dict.to_pairs(assets.tokens(mint, policy_id))
  expect Some(out) = list.at(outputs, escrow_output_index)
  expect InlineDatum(raw) = out.datum
  expect datum: EscrowDatum = raw
  and {
    (minted_name == name)?,
    (out.address.payment_credential == Script(policy_id))?,
    (assets.quantity_of(out.value, policy_id, name) == 1)?,
    (datum.released_count == 0)?,
    (datum.milestones != [])?,
    list.all(datum.milestones, fn(m) { m > 0 })?,
    (assets.quantity_of(out.value, datum.asset_policy, datum.asset_name) >= milestones_total(
      datum.milestones,
    ))?,
    (datum.expiry > 0)?,
    credential_hash_valid(datum.funder.payment_credential)?,
    credential_hash_valid(datum.beneficiary.payment_credential)?,
    credential_hash_valid(datum.verifier)?,
    // [security]: own-script parties would make Script-authorization vacuous (the
    // escrow input itself would satisfy credential_authorized) and payouts
    // unspendable — banned at creation.
    (datum.funder.payment_credential != Script(policy_id))?,
    (datum.beneficiary.payment_credential != Script(policy_id))?,
    (datum.verifier != Script(policy_id))?,
  }
}

// [security]: burn-only — every quantity of this policy negative, nothing minted.
// The spend paths (Release final / Reclaim / Abort) enforce WHICH token burns.
pub fn validate_burn_escrow(policy_id: PolicyId, mint: Value) -> Bool {
  let burned = dict.to_pairs(assets.tokens(mint, policy_id))
  burned != [] && list.all(
    burned,
    fn(pair) {
      let Pair(_, qty) = pair
      qty < 0
    },
  )
}
