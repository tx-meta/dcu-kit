use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite, Interval}
use aiken/primitive/bytearray
use cardano/assets.{PolicyId, Value}
use cardano/address.{Script, VerificationKey}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use escrow/credential.{credential_authorized, state_token_name}
use escrow/types.{EscrowDatum}

// Release cost is linear in the milestone-list length (~17K mem/tranche measured);
// the cap keeps the longest schedule's release under ~2M mem of the 14M budget and
// closes the griefing vector where an unreleasable schedule strands the beneficiary
// until the funder reclaims at expiry.
pub const max_milestones: Int = 100

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
  validity_range: Interval,
) -> Bool {
  expect Some(seed) = list.at(inputs, seed_input_index)
  let name = state_token_name(seed.output_reference)
  expect [Pair(minted_name, 1)] = dict.to_pairs(assets.tokens(mint, policy_id))
  expect Some(out) = list.at(outputs, escrow_output_index)
  expect InlineDatum(raw) = out.datum
  expect datum: EscrowDatum = raw
  // The pinned upper bound proves creation strictly before expiry — an escrow can
  // never be born already reclaimable.
  expect Finite(upper) = validity_range.upper_bound.bound_type
  and {
    (minted_name == name)?,
    (out.address.payment_credential == Script(policy_id))?,
    (assets.quantity_of(out.value, policy_id, name) == 1)?,
    (datum.released_count == 0)?,
    (datum.milestones != [])?,
    (list.length(datum.milestones) <= max_milestones)?,
    (upper < datum.expiry)?,
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

// [security]: exactly one input from the escrow's own script address per tx —
// kills double-satisfaction across escrows (one payout output cannot settle two
// escrow spends). Called by every spend path.
pub fn only_own_input(policy_id: PolicyId, inputs: List<Input>) -> Bool {
  list.count(
    inputs,
    fn(i) { i.output.address.payment_credential == Script(policy_id) },
  ) == 1
}

// [spec 3.5 Release]: verifier-authorized sequential tranche to the beneficiary,
// strictly before expiry; non-final releases continue at the spent input's full
// address with only released_count advanced; the final release burns the token.
pub fn validate_release(
  policy_id: PolicyId,
  datum: EscrowDatum,
  own_input: Input,
  continuation_index: Int,
  payout_index: Int,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  // Deterministic boundary: releases require a pinned upper bound at/before expiry.
  expect Finite(upper) = tx.validity_range.upper_bound.bound_type
  expect Some(tranche) = list.at(datum.milestones, datum.released_count)
  expect [Pair(state_name, 1)] =
    dict.to_pairs(assets.tokens(own_input.output.value, policy_id))
  expect Some(payout) = list.at(outputs, payout_index)
  let in_value = own_input.output.value
  let is_final = datum.released_count + 1 == list.length(datum.milestones)
  let base = and {
      (upper <= datum.expiry)?,
      credential_authorized(datum.verifier, tx)?,
      (payout.address == datum.beneficiary)?,
      (assets.quantity_of(payout.value, datum.asset_policy, datum.asset_name) >= tranche)?,
    }
  if is_final {
    base && (assets.quantity_of(mint, policy_id, state_name) == -1)?
  } else {
    expect Some(cont) = list.at(outputs, continuation_index)
    expect InlineDatum(raw) = cont.datum
    expect cont_datum: EscrowDatum = raw
    let expected =
      EscrowDatum { ..datum, released_count: datum.released_count + 1 }
    let value_ok =
      if datum.asset_policy == assets.ada_policy_id {
        assets.lovelace_of(cont.value) >= assets.lovelace_of(in_value) - tranche
      } else {
        and {
          assets.quantity_of(cont.value, datum.asset_policy, datum.asset_name) >= assets.quantity_of(
            in_value,
            datum.asset_policy,
            datum.asset_name,
          ) - tranche,
          assets.lovelace_of(cont.value) >= assets.lovelace_of(in_value),
        }
      }
    base && and {
      // [AIK-4]: continuation pinned to the spent input's FULL address.
      (cont.address == own_input.output.address)?,
      (assets.quantity_of(cont.value, policy_id, state_name) == 1)?,
      (cont_datum == expected)?,
      value_ok?,
    }
  }
}

// [spec 3.5 Reclaim]: strictly after expiry the funder recovers the remaining
// asset balance to their own full address; the state token burns.
pub fn validate_reclaim(
  policy_id: PolicyId,
  datum: EscrowDatum,
  own_input: Input,
  refund_index: Int,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect Finite(lower) = tx.validity_range.lower_bound.bound_type
  expect [Pair(state_name, 1)] =
    dict.to_pairs(assets.tokens(own_input.output.value, policy_id))
  expect Some(refund) = list.at(outputs, refund_index)
  let in_value = own_input.output.value
  and {
    (lower > datum.expiry)?,
    credential_authorized(datum.funder.payment_credential, tx)?,
    (refund.address == datum.funder)?,
    (assets.quantity_of(refund.value, datum.asset_policy, datum.asset_name) >= assets.quantity_of(
      in_value,
      datum.asset_policy,
      datum.asset_name,
    ))?,
    (assets.quantity_of(mint, policy_id, state_name) == -1)?,
  }
}

// [spec 3.5 Abort]: funder AND beneficiary co-sign; distribution is free (the only
// two economic parties agreed); the state token burns.
pub fn validate_abort(
  policy_id: PolicyId,
  datum: EscrowDatum,
  own_input: Input,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect [Pair(state_name, 1)] =
    dict.to_pairs(assets.tokens(own_input.output.value, policy_id))
  and {
    credential_authorized(datum.funder.payment_credential, tx)?,
    credential_authorized(datum.beneficiary.payment_credential, tx)?,
    (assets.quantity_of(mint, policy_id, state_name) == -1)?,
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
