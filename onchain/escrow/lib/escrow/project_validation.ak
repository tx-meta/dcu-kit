use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use escrow/credential.{credential_authorized, state_token_name}
use escrow/types_v2.{ProjectDatum}

// [spec 3.4]: the Project is a passive anchor — identity + metadata + status,
// freely mutable by its owner. Escrows cite it by opaque token name only, so no
// project mutation can ever break an escrow.

fn owner_valid(owner: Credential, policy_id: PolicyId) -> Bool {
  let hash_ok = when owner is {
    VerificationKey(h) -> bytearray.length(h) == 28
    Script(h) -> bytearray.length(h) == 28
  }
  // [security]: an own-script owner would make owner-authorization vacuous.
  hash_ok && owner != Script(policy_id)
}

fn datum_valid(datum: ProjectDatum, policy_id: PolicyId) -> Bool {
  and {
    (datum.status == 0 || datum.status == 1)?,
    // [security]: cap the only unbounded field a writer controls.
    (bytearray.length(datum.title) <= 64)?,
    owner_valid(datum.owner, policy_id)?,
  }
}

// [security]: exactly one input from the project's own script address per tx.
pub fn only_own_project_input(policy_id: PolicyId, inputs: List<Input>) -> Bool {
  list.count(
    inputs,
    fn(i) { i.output.address.payment_credential == Script(policy_id) },
  ) == 1
}

// [spec 3.4 CreateProject]: one-shot NFT from a seed input; output at the
// validator's own address holding exactly the token and a valid Active datum.
pub fn validate_create_project(
  policy_id: PolicyId,
  seed_input_index: Int,
  project_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  expect Some(seed) = list.at(inputs, seed_input_index)
  let name = state_token_name(seed.output_reference)
  expect [Pair(minted_name, 1)] = dict.to_pairs(assets.tokens(mint, policy_id))
  expect Some(out) = list.at(outputs, project_output_index)
  expect InlineDatum(raw) = out.datum
  expect datum: ProjectDatum = raw
  and {
    (minted_name == name)?,
    (out.address.payment_credential == Script(policy_id))?,
    // [security]: exactly the project NFT under this policy in the output.
    (dict.to_pairs(assets.tokens(out.value, policy_id)) == [Pair(name, 1)])?,
    // [security]: only ADA + own policy — no foreign-token accumulation.
    (assets.policies(out.value) == [assets.ada_policy_id, policy_id])?,
    (datum.status == 0)?,
    owner_valid(datum.owner, policy_id)?,
  }
}

// [spec 3.4 UpdateProject]: owner-authorized; title / content_hash / status /
// owner all freely mutable; the NFT stays at the script address and lovelace
// never decreases.
pub fn validate_update_project(
  policy_id: PolicyId,
  datum: ProjectDatum,
  own_input: Input,
  continuation_index: Int,
  outputs: List<Output>,
  tx: Transaction,
) -> Bool {
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  expect Some(cont) = list.at(outputs, continuation_index)
  expect InlineDatum(raw) = cont.datum
  expect cont_datum: ProjectDatum = raw
  and {
    credential_authorized(datum.owner, tx)?,
    (cont.address == own_input.output.address)?,
    (dict.to_pairs(assets.tokens(cont.value, policy_id)) == [
      Pair(state_name, 1),
    ])?,
    (assets.policies(cont.value) == [assets.ada_policy_id, policy_id])?,
    datum_valid(cont_datum, policy_id),
    (assets.lovelace_of(cont.value) >= assets.lovelace_of(
      own_input.output.value,
    ))?,
  }
}

// [spec 3.4 CloseProject]: owner-authorized burn — the anchor disappears;
// escrows citing it are unaffected (opaque id, never dereferenced on-chain).
pub fn validate_close_project(
  policy_id: PolicyId,
  datum: ProjectDatum,
  own_input: Input,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  and {
    credential_authorized(datum.owner, tx)?,
    (assets.quantity_of(mint, policy_id, state_name) == -1)?,
  }
}

// [security]: burn-only — nothing minted under this policy.
pub fn validate_burn_project(policy_id: PolicyId, mint: Value) -> Bool {
  let burned = dict.to_pairs(assets.tokens(mint, policy_id))
  burned != [] && list.all(
    burned,
    fn(pair) {
      let Pair(_, qty) = pair
      qty < 0
    },
  )
}
