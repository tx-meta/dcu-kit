use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite, Interval}
use aiken/primitive/bytearray
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use escrow/credential.{credential_authorized, state_token_name}
use escrow/types_v2.{
  ArbiterParty, BeneficiaryParty, DisputeInfo, EscrowDatumV2, FunderParty,
  Milestone, Party, PerMilestone, RefundToFunder, ReleaseToBeneficiary, Upfront,
  VerifierParty,
}

// Same schedule ceiling as v1 — keeps the longest release under budget and
// closes the unreleasable-schedule griefing vector.
pub const max_milestones: Int = 100

// Protocol convention shared with the SDK: the lovelace buffer locked at create
// (ADA escrows: on top of the milestone total; native-token escrows: the whole
// lovelace, funding the final payout's min-ADA).
pub const min_ada_buffer: Int = 2_000_000

// [security]: title is the only unbounded-by-type datum field a party writes —
// cap it so no datum can grow past spendability (long descriptions belong
// off-chain behind content_hash).
pub const max_title_bytes: Int = 64

// ── shared helpers ───────────────────────────────────────────────────────────

fn credential_hash_valid(cred: Credential) -> Bool {
  when cred is {
    VerificationKey(h) -> bytearray.length(h) == 28
    Script(h) -> bytearray.length(h) == 28
  }
}

pub fn milestones_total(milestones: List<Milestone>) -> Int {
  list.foldl(milestones, 0, fn(m, acc) { m.amount + acc })
}

// Remaining (unreleased) milestone total.
pub fn remaining_total(datum: EscrowDatumV2) -> Int {
  milestones_total(list.drop(datum.milestones, datum.released_count))
}

// [spec 3.1]: 1-100 entries, every amount > 0, deadlines strictly increasing.
pub fn milestones_valid(milestones: List<Milestone>) -> Bool {
  and {
    milestones != [],
    list.length(milestones) <= max_milestones,
    list.all(milestones, fn(m) { m.amount > 0 }),
    deadlines_increasing(milestones),
  }
}

fn deadlines_increasing(milestones: List<Milestone>) -> Bool {
  when milestones is {
    [] -> True
    [_] -> True
    [a, b, ..rest] -> a.deadline < b.deadline && deadlines_increasing([b, ..rest])
  }
}

// [spec 3.2 dispute-aware timing]: the current milestone's cure boundary —
// deadline + grace, extended by dispute_window when this milestone was disputed
// so a last-moment dispute cannot steal the counterparty's window.
pub fn cure_boundary(datum: EscrowDatumV2) -> Int {
  expect Some(m) = list.at(datum.milestones, datum.released_count)
  let extension =
    when datum.dispute is {
      Some(d) ->
        if d.milestone == datum.released_count {
          datum.dispute_window
        } else {
          0
        }
      None -> 0
    }
  m.deadline + datum.grace + extension
}

// [spec 3.2 dispute-aware timing]: fund paths are frozen while a dispute on the
// CURRENT milestone has not lapsed. Proving "not frozen" for a disputed
// milestone requires a pinned lower bound strictly past `until`.
pub fn dispute_clear(datum: EscrowDatumV2, range: Interval) -> Bool {
  when datum.dispute is {
    None -> True
    Some(d) ->
      if d.milestone == datum.released_count {
        expect Finite(lower) = range.lower_bound.bound_type
        lower > d.until
      } else {
        True
      }
  }
}

// [spec 3.3]: verifier != beneficiary; when an arbiter exists it is distinct
// from funder, beneficiary, AND verifier; every credential hash well-formed;
// no own-script parties (they would make Script-authorization vacuous).
pub fn party_guardrails_ok(datum: EscrowDatumV2, policy_id: PolicyId) -> Bool {
  let base = and {
    (datum.verifier != datum.beneficiary.payment_credential)?,
    credential_hash_valid(datum.funder.payment_credential)?,
    credential_hash_valid(datum.beneficiary.payment_credential)?,
    credential_hash_valid(datum.verifier)?,
    (datum.funder.payment_credential != Script(policy_id))?,
    (datum.beneficiary.payment_credential != Script(policy_id))?,
    (datum.verifier != Script(policy_id))?,
  }
  when datum.arbiter is {
    None -> base
    Some(a) -> and {
        base,
        credential_hash_valid(a)?,
        (a != datum.funder.payment_credential)?,
        (a != datum.beneficiary.payment_credential)?,
        (a != datum.verifier)?,
        (a != Script(policy_id))?,
      }
  }
}

// [spec 3.3 funding]: Upfront locks the full remaining total (+ buffer for ADA);
// PerMilestone locks at least the buffer. Checked at create AND after amendment.
pub fn funding_ok(datum: EscrowDatumV2, value: Value) -> Bool {
  let is_ada = datum.asset_policy == assets.ada_policy_id
  when datum.funding_mode is {
    Upfront ->
      if is_ada {
        assets.lovelace_of(value) >= remaining_total(datum) + min_ada_buffer
      } else {
        and {
          assets.quantity_of(value, datum.asset_policy, datum.asset_name) >= remaining_total(
            datum,
          ),
          assets.lovelace_of(value) >= min_ada_buffer,
        }
      }
    PerMilestone -> assets.lovelace_of(value) >= min_ada_buffer
  }
}

// [security]: exactly one input from the escrow's own script address per tx —
// kills double-satisfaction across escrows. Called by every spend path.
pub fn only_own_input(policy_id: PolicyId, inputs: List<Input>) -> Bool {
  list.count(
    inputs,
    fn(i) { i.output.address.payment_credential == Script(policy_id) },
  ) == 1
}

// [security]: continuation output holds EXACTLY the state token under this
// policy — prevents token stuffing / UTxO-merge across two escrows in one tx.
pub fn exact_state_token(
  value: Value,
  policy_id: PolicyId,
  state_name: ByteArray,
) -> Bool {
  dict.to_pairs(assets.tokens(value, policy_id)) == [Pair(state_name, 1)]
}

// [security]: continuation carries only ADA + own policy (+ the escrow asset's
// policy) — prevents unbounded value accumulation in the script UTxO.
pub fn continuation_policies_ok(
  value: Value,
  policy_id: PolicyId,
  asset_policy: PolicyId,
) -> Bool {
  let ps = assets.policies(value)
  or {
    ps == [assets.ada_policy_id, policy_id],
    ps == sorted_policy_triple(policy_id, asset_policy),
  }
}

fn sorted_policy_triple(
  policy_id: PolicyId,
  asset_policy: PolicyId,
) -> List<PolicyId> {
  if asset_policy == assets.ada_policy_id {
    // ADA escrow: no third policy is ever legal.
    [assets.ada_policy_id, policy_id]
  } else if bytearray.compare(asset_policy, policy_id) == Less {
    [assets.ada_policy_id, asset_policy, policy_id]
  } else {
    [assets.ada_policy_id, policy_id, asset_policy]
  }
}

// ── fund paths ───────────────────────────────────────────────────────────────

// [spec 3.2 Release]: verifier-authorized sequential tranche, upper bound at or
// before the (dispute-extended) cure boundary, not frozen.
pub fn validate_release_v2(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
  own_input: Input,
  continuation_index: Int,
  payout_index: Int,
  funder_index: Int,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  // [spec 3.2]: deterministic boundary — a pinned upper bound is required.
  expect Finite(upper) = tx.validity_range.upper_bound.bound_type
  and {
    (upper <= cure_boundary(datum))?,
    dispute_clear(datum, tx.validity_range)?,
    credential_authorized(datum.verifier, tx)?,
    tranche_payout_ok(
      policy_id,
      datum,
      own_input,
      continuation_index,
      payout_index,
      funder_index,
      outputs,
      mint,
    ),
  }
}

// [spec 3.2 TimeoutRelease]: past the cure window, silence approves — the
// tranche becomes releasable to the beneficiary with NO signer requirement
// (payout destination is fixed by the datum, so anyone may crank).
pub fn validate_timeout_release(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
  own_input: Input,
  continuation_index: Int,
  payout_index: Int,
  funder_index: Int,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect Finite(lower) = tx.validity_range.lower_bound.bound_type
  and {
    (datum.timeout_policy == ReleaseToBeneficiary)?,
    (lower > cure_boundary(datum))?,
    dispute_clear(datum, tx.validity_range)?,
    tranche_payout_ok(
      policy_id,
      datum,
      own_input,
      continuation_index,
      payout_index,
      funder_index,
      outputs,
      mint,
    ),
  }
}

// [spec 3.2 Reclaim]: RefundToFunder mode only — strictly after the cure
// boundary the funder recovers the WHOLE remainder (asset + lovelace incl.
// buffer) to their own full address; the state token burns.
pub fn validate_reclaim_v2(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
  own_input: Input,
  refund_index: Int,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect Finite(lower) = tx.validity_range.lower_bound.bound_type
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  expect Some(refund) = list.at(outputs, refund_index)
  let in_value = own_input.output.value
  and {
    (datum.timeout_policy == RefundToFunder)?,
    (lower > cure_boundary(datum))?,
    dispute_clear(datum, tx.validity_range)?,
    credential_authorized(datum.funder.payment_credential, tx)?,
    (refund.address == datum.funder)?,
    (assets.lovelace_of(refund.value) >= assets.lovelace_of(in_value))?,
    (assets.quantity_of(refund.value, datum.asset_policy, datum.asset_name) >= assets.quantity_of(
      in_value,
      datum.asset_policy,
      datum.asset_name,
    ))?,
    (assets.quantity_of(mint, policy_id, state_name) == -1)?,
  }
}

// Shared tranche mechanics for Release and TimeoutRelease: sequential payout to
// the beneficiary, PerMilestone funded check, continuation or final burn with
// the remainder returned to the funder on-chain.
fn tranche_payout_ok(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
  own_input: Input,
  continuation_index: Int,
  payout_index: Int,
  funder_index: Int,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  expect Some(m) = list.at(datum.milestones, datum.released_count)
  let tranche = m.amount
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  expect Some(payout) = list.at(outputs, payout_index)
  let in_value = own_input.output.value
  let is_ada = datum.asset_policy == assets.ada_policy_id
  let is_final = datum.released_count + 1 == list.length(datum.milestones)
  let base = and {
    // [spec 3.2]: PerMilestone — the current tranche must actually be funded
    // (trivially true for a fully-funded Upfront escrow).
    (assets.quantity_of(in_value, datum.asset_policy, datum.asset_name) >= tranche)?,
    (payout.address == datum.beneficiary)?,
    (assets.quantity_of(payout.value, datum.asset_policy, datum.asset_name) >= tranche)?,
  }
  if is_final {
    // [spec 3.2 final]: burn + the remainder goes back to the FUNDER on-chain —
    // the 2026-07-11 offchain fix promoted into the validator. For native-token
    // escrows the buffer keeps funding the beneficiary payout's min-ADA.
    let ada_remainder =
      if is_ada {
        assets.lovelace_of(in_value) - tranche
      } else {
        assets.lovelace_of(in_value) - min_ada_buffer
      }
    let asset_remainder =
      if is_ada {
        0
      } else {
        assets.quantity_of(in_value, datum.asset_policy, datum.asset_name) - tranche
      }
    let remainder_ok =
      if ada_remainder > 0 || asset_remainder > 0 {
        expect Some(funder_out) = list.at(outputs, funder_index)
        and {
          (funder_out.address == datum.funder)?,
          (assets.lovelace_of(funder_out.value) >= ada_remainder)?,
          (assets.quantity_of(
            funder_out.value,
            datum.asset_policy,
            datum.asset_name,
          ) >= asset_remainder)?,
        }
      } else {
        True
      }
    and {
      base,
      remainder_ok,
      (assets.quantity_of(mint, policy_id, state_name) == -1)?,
    }
  } else {
    expect Some(cont) = list.at(outputs, continuation_index)
    expect InlineDatum(raw) = cont.datum
    expect cont_datum: EscrowDatumV2 = raw
    let expected =
      EscrowDatumV2 { ..datum, released_count: datum.released_count + 1 }
    let value_ok =
      if is_ada {
        assets.lovelace_of(cont.value) >= assets.lovelace_of(in_value) - tranche
      } else {
        and {
          assets.quantity_of(cont.value, datum.asset_policy, datum.asset_name) >= assets.quantity_of(
            in_value,
            datum.asset_policy,
            datum.asset_name,
          ) - tranche,
          // Buffer preserved through every non-final release — it funds the
          // FINAL payout's min-ADA; the crank pays interim payout min-ADA.
          assets.lovelace_of(cont.value) >= assets.lovelace_of(in_value),
        }
      }
    and {
      base,
      // [AIK-4]: continuation pinned to the spent input's FULL address.
      (cont.address == own_input.output.address)?,
      exact_state_token(cont.value, policy_id, state_name)?,
      continuation_policies_ok(cont.value, policy_id, datum.asset_policy)?,
      (cont_datum == expected)?,
      value_ok?,
    }
  }
}

// ── consent + state paths ────────────────────────────────────────────────────

// [spec 3.2 Abort]: funder AND beneficiary co-sign; distribution is free (the
// only two economic parties agreed); the state token burns. Works even while a
// dispute freeze is active — consent always works.
pub fn validate_abort_v2(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
  own_input: Input,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  and {
    credential_authorized(datum.funder.payment_credential, tx)?,
    credential_authorized(datum.beneficiary.payment_credential, tx)?,
    (assets.quantity_of(mint, policy_id, state_name) == -1)?,
  }
}

// [spec 3.2 Contribute]: funder-authorized top-up, PerMilestone escrows only;
// the datum is byte-identical and value only grows.
pub fn validate_contribute(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
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
  expect cont_datum: EscrowDatumV2 = raw
  let in_value = own_input.output.value
  and {
    (datum.funding_mode == PerMilestone)?,
    credential_authorized(datum.funder.payment_credential, tx)?,
    (cont.address == own_input.output.address)?,
    exact_state_token(cont.value, policy_id, state_name)?,
    continuation_policies_ok(cont.value, policy_id, datum.asset_policy)?,
    (cont_datum == datum)?,
    // [spec 3.2]: escrow-asset balance strictly increases…
    (assets.quantity_of(cont.value, datum.asset_policy, datum.asset_name) > assets.quantity_of(
      in_value,
      datum.asset_policy,
      datum.asset_name,
    ))?,
    // …and lovelace never decreases (relevant for native-token escrows).
    (assets.lovelace_of(cont.value) >= assets.lovelace_of(in_value))?,
  }
}

// [spec 3.2 SubmitEvidence]: beneficiary-authorized; writes exactly ONE
// evidence slot at an unreleased index; value untouched. Overwritable until
// that milestone is released; no effect on fund movement.
pub fn validate_submit_evidence(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
  own_input: Input,
  continuation_index: Int,
  milestone_index: Int,
  evidence_hash: ByteArray,
  outputs: List<Output>,
  tx: Transaction,
) -> Bool {
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  expect Some(cont) = list.at(outputs, continuation_index)
  expect InlineDatum(raw) = cont.datum
  expect cont_datum: EscrowDatumV2 = raw
  let expected =
    EscrowDatumV2 {
      ..datum,
      evidence: list.indexed_map(
        datum.evidence,
        fn(ix, e) {
          if ix == milestone_index {
            Some(evidence_hash)
          } else {
            e
          }
        },
      ),
    }
  and {
    credential_authorized(datum.beneficiary.payment_credential, tx)?,
    (milestone_index >= datum.released_count)?,
    (milestone_index < list.length(datum.milestones))?,
    (cont.address == own_input.output.address)?,
    exact_state_token(cont.value, policy_id, state_name)?,
    (cont_datum == expected)?,
    (cont.value == own_input.output.value)?,
  }
}

// [spec 3.2 RotateParty]: each party may replace only ITSELF, signing with the
// CURRENT credential. No cross-party replacement — funder+verifier must never
// be able to redirect the beneficiary's payouts.
pub fn validate_rotate_party(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
  own_input: Input,
  continuation_index: Int,
  party: Party,
  outputs: List<Output>,
  tx: Transaction,
) -> Bool {
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  expect Some(cont) = list.at(outputs, continuation_index)
  expect InlineDatum(raw) = cont.datum
  expect cont_datum: EscrowDatumV2 = raw
  // Reverting the rotated field must reproduce the old datum exactly — this is
  // the "exactly one field changed" proof.
  let reverted =
    when party is {
      FunderParty -> EscrowDatumV2 { ..cont_datum, funder: datum.funder }
      BeneficiaryParty ->
        EscrowDatumV2 { ..cont_datum, beneficiary: datum.beneficiary }
      VerifierParty -> EscrowDatumV2 { ..cont_datum, verifier: datum.verifier }
      ArbiterParty -> EscrowDatumV2 { ..cont_datum, arbiter: datum.arbiter }
    }
  let authorized =
    when party is {
      FunderParty -> credential_authorized(datum.funder.payment_credential, tx)
      BeneficiaryParty ->
        credential_authorized(datum.beneficiary.payment_credential, tx)
      VerifierParty -> credential_authorized(datum.verifier, tx)
      ArbiterParty -> {
        // [spec 3.2]: arbiter rotation requires an arbiter to exist…
        expect Some(a) = datum.arbiter
        credential_authorized(a, tx)
      }
    }
  // …and can never remove it (Some↔None is forbidden; the revert trick alone
  // would let Some→None slip through).
  let arbiter_shape_ok =
    when party is {
      ArbiterParty -> cont_datum.arbiter != None
      _ -> True
    }
  and {
    authorized?,
    (reverted == datum)?,
    arbiter_shape_ok?,
    party_guardrails_ok(cont_datum, policy_id)?,
    (cont.address == own_input.output.address)?,
    exact_state_token(cont.value, policy_id, state_name)?,
    (cont.value == own_input.output.value)?,
  }
}

// [spec 3.2 AmendMilestones]: funder + beneficiary co-sign; released prefix
// immutable; the new schedule re-validated whole; value may only exit toward
// the FUNDER and never below the funded requirement for the escrow's mode.
pub fn validate_amend_milestones(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
  own_input: Input,
  continuation_index: Int,
  funder_index: Int,
  outputs: List<Output>,
  tx: Transaction,
) -> Bool {
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  expect Some(cont) = list.at(outputs, continuation_index)
  expect InlineDatum(raw) = cont.datum
  expect cont_datum: EscrowDatumV2 = raw
  // Only milestones / evidence / title / content_hash may change.
  let reverted =
    EscrowDatumV2 {
      ..cont_datum,
      milestones: datum.milestones,
      evidence: datum.evidence,
      title: datum.title,
      content_hash: datum.content_hash,
    }
  let rc = datum.released_count
  let in_value = own_input.output.value
  // [spec 3.2]: any value leaving the escrow in the amendment goes to the funder.
  let l_deficit = assets.lovelace_of(in_value) - assets.lovelace_of(cont.value)
  let a_deficit =
    assets.quantity_of(in_value, datum.asset_policy, datum.asset_name) - assets.quantity_of(
      cont.value,
      datum.asset_policy,
      datum.asset_name,
    )
  let exit_ok =
    if l_deficit > 0 || a_deficit > 0 {
      expect Some(funder_out) = list.at(outputs, funder_index)
      and {
        (funder_out.address == datum.funder)?,
        (assets.lovelace_of(funder_out.value) >= l_deficit)?,
        (assets.quantity_of(
          funder_out.value,
          datum.asset_policy,
          datum.asset_name,
        ) >= a_deficit)?,
      }
    } else {
      True
    }
  and {
    credential_authorized(datum.funder.payment_credential, tx)?,
    credential_authorized(datum.beneficiary.payment_credential, tx)?,
    (reverted == datum)?,
    // [spec 3.2]: history immutable — released milestones and their evidence.
    (list.take(cont_datum.milestones, rc) == list.take(datum.milestones, rc))?,
    (list.take(cont_datum.evidence, rc) == list.take(datum.evidence, rc))?,
    milestones_valid(cont_datum.milestones)?,
    (list.length(cont_datum.evidence) == list.length(cont_datum.milestones))?,
    (bytearray.length(cont_datum.title) <= max_title_bytes)?,
    (cont.address == own_input.output.address)?,
    exact_state_token(cont.value, policy_id, state_name)?,
    continuation_policies_ok(cont.value, policy_id, datum.asset_policy)?,
    // [spec 3.2]: the Upfront guarantee never has a gap through an amendment.
    funding_ok(cont_datum, cont.value)?,
    exit_ok,
  }
}

// ── dispute paths ────────────────────────────────────────────────────────────

// [spec 3.2 RaiseDispute]: funder or beneficiary freezes the fund paths for
// dispute_window. One dispute per milestone, maximum — bounds freeze-griefing.
pub fn validate_raise_dispute(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
  own_input: Input,
  continuation_index: Int,
  outputs: List<Output>,
  tx: Transaction,
) -> Bool {
  // [spec 3.2]: no arbiter, no dispute path.
  expect Some(_) = datum.arbiter
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  expect Some(cont) = list.at(outputs, continuation_index)
  expect InlineDatum(raw) = cont.datum
  expect cont_datum: EscrowDatumV2 = raw
  // [spec 3.2]: until is anchored at the tx's pinned upper bound.
  expect Finite(upper) = tx.validity_range.upper_bound.bound_type
  let fresh =
    when datum.dispute is {
      None -> True
      Some(d) -> d.milestone < datum.released_count
    }
  let expected =
    EscrowDatumV2 {
      ..datum,
      dispute: Some(
        DisputeInfo {
          milestone: datum.released_count,
          until: upper + datum.dispute_window,
        },
      ),
    }
  and {
    fresh?,
    or {
      credential_authorized(datum.funder.payment_credential, tx),
      credential_authorized(datum.beneficiary.payment_credential, tx),
    }?,
    (cont.address == own_input.output.address)?,
    exact_state_token(cont.value, policy_id, state_name)?,
    (cont_datum == expected)?,
    (cont.value == own_input.output.value)?,
  }
}

// [spec 3.2 ResolveDispute]: arbiter-signed terminal split. The whole remainder
// may go ONLY to the funder's and beneficiary's addresses — the arbiter can
// never pay itself or a third party. Resolvable while the dispute marker is on
// the current milestone, even after the freeze lapses.
pub fn validate_resolve_dispute(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
  own_input: Input,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect Some(arbiter) = datum.arbiter
  expect Some(d) = datum.dispute
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  let in_value = own_input.output.value
  // Sum everything the tx pays to the two economic parties.
  let (party_lovelace, party_asset) =
    list.foldl(
      outputs,
      (0, 0),
      fn(out, acc) {
        let (l, a) = acc
        if out.address == datum.funder || out.address == datum.beneficiary {
          (
            l + assets.lovelace_of(out.value),
            a + assets.quantity_of(
              out.value,
              datum.asset_policy,
              datum.asset_name,
            ),
          )
        } else {
          acc
        }
      },
    )
  and {
    credential_authorized(arbiter, tx)?,
    (d.milestone == datum.released_count)?,
    (party_lovelace >= assets.lovelace_of(in_value))?,
    (party_asset >= assets.quantity_of(
      in_value,
      datum.asset_policy,
      datum.asset_name,
    ))?,
    (assets.quantity_of(mint, policy_id, state_name) == -1)?,
  }
}

// ── create / burn ────────────────────────────────────────────────────────────

// [spec 3.3]: one-shot state token; escrow output at the validator's own address
// with the token and a well-formed initial datum; funding per mode; not born
// past its first cure window.
pub fn validate_create_escrow_v2(
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
  expect datum: EscrowDatumV2 = raw
  // [spec 3.3]: the pinned upper bound proves creation strictly before the first
  // cure window — an escrow can never be born already timed out.
  expect Finite(upper) = validity_range.upper_bound.bound_type
  expect Some(first) = list.head(datum.milestones)
  and {
    (minted_name == name)?,
    (out.address.payment_credential == Script(policy_id))?,
    exact_state_token(out.value, policy_id, name)?,
    continuation_policies_ok(out.value, policy_id, datum.asset_policy)?,
    (datum.released_count == 0)?,
    milestones_valid(datum.milestones)?,
    (upper < first.deadline + datum.grace)?,
    (datum.grace >= 0)?,
    (datum.dispute_window >= 0)?,
    (datum.dispute == None)?,
    (list.length(datum.evidence) == list.length(datum.milestones))?,
    list.all(datum.evidence, fn(e) { e == None })?,
    (bytearray.length(datum.title) <= max_title_bytes)?,
    party_guardrails_ok(datum, policy_id)?,
    funding_ok(datum, out.value)?,
  }
}

// [security]: burn-only — every quantity of this policy negative, nothing
// minted. The spend paths enforce WHICH token burns.
pub fn validate_burn_escrow_v2(policy_id: PolicyId, mint: Value) -> Bool {
  let burned = dict.to_pairs(assets.tokens(mint, policy_id))
  burned != [] && list.all(
    burned,
    fn(pair) {
      let Pair(_, qty) = pair
      qty < 0
    },
  )
}
