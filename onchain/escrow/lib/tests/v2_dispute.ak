use cardano/address.{VerificationKey}
use cardano/address as addr
use cardano/assets
use cardano/transaction.{Output, Transaction, placeholder}
use escrow/escrow_v2_validation.{
  validate_raise_dispute, validate_resolve_dispute,
}
use escrow/types_v2.{DisputeInfo, EscrowDatumV2}
use tests/common.{
  beneficiary_address, beneficiary_pkh, escrow_input, funder_address,
  funder_pkh, range_before, seed_token_name, user_output, verifier_pkh,
}
use tests/common_v2.{
  arbiter_pkh, escrow_v2_output, escrow_v2_policy, hour, t0, test_v2_datum,
  v2_utxo_value,
}

fn with_arbiter() -> EscrowDatumV2 {
  EscrowDatumV2 {
    ..test_v2_datum(),
    arbiter: Some(VerificationKey(arbiter_pkh())),
  }
}

fn escrow_in(datum: EscrowDatumV2, lovelace: Int) {
  escrow_input(
    0,
    escrow_v2_output(
      escrow_v2_policy(),
      datum,
      v2_utxo_value(escrow_v2_policy(), lovelace),
    ),
  )
}

fn burn_one() {
  assets.from_asset(escrow_v2_policy(), seed_token_name(), -1)
}

// Raise at upper bound t0: until = t0 + dispute_window (1h).
fn raised(datum: EscrowDatumV2) -> EscrowDatumV2 {
  EscrowDatumV2 {
    ..datum,
    dispute: Some(DisputeInfo { milestone: datum.released_count, until: t0 + hour }),
  }
}

fn raise_tx(signer: ByteArray, outputs: List<Output>) -> Transaction {
  Transaction {
    ..placeholder,
    outputs: outputs,
    extra_signatories: [signer],
    validity_range: range_before(t0),
  }
}

// ── RaiseDispute ─────────────────────────────────────────────────────────────

test raise__accepts_funder() {
  let datum = with_arbiter()
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      raised(datum),
      v2_utxo_value(escrow_v2_policy(), 102_000_000),
    )
  validate_raise_dispute(
    escrow_v2_policy(),
    datum,
    own,
    0,
    [cont],
    raise_tx(funder_pkh(), [cont]),
  )
}

test raise__accepts_beneficiary() {
  let datum = with_arbiter()
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      raised(datum),
      v2_utxo_value(escrow_v2_policy(), 102_000_000),
    )
  validate_raise_dispute(
    escrow_v2_policy(),
    datum,
    own,
    0,
    [cont],
    raise_tx(beneficiary_pkh(), [cont]),
  )
}

test raise__rejects_without_arbiter() fail {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      raised(datum),
      v2_utxo_value(escrow_v2_policy(), 102_000_000),
    )
  validate_raise_dispute(
    escrow_v2_policy(),
    datum,
    own,
    0,
    [cont],
    raise_tx(funder_pkh(), [cont]),
  )
}

test raise__rejects_second_dispute_same_milestone() {
  let datum = raised(with_arbiter())
  let own = escrow_in(datum, 102_000_000)
  let re_raised =
    EscrowDatumV2 {
      ..datum,
      dispute: Some(DisputeInfo { milestone: 0, until: t0 + 3 * hour }),
    }
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      re_raised,
      v2_utxo_value(escrow_v2_policy(), 102_000_000),
    )
  !validate_raise_dispute(
    escrow_v2_policy(),
    datum,
    own,
    0,
    [cont],
    raise_tx(funder_pkh(), [cont]),
  )
}

test raise__accepts_dispute_on_next_milestone() {
  // Milestone 0 was disputed and released; a dispute on milestone 1 is fresh.
  let base =
    EscrowDatumV2 {
      ..with_arbiter(),
      released_count: 1,
      dispute: Some(DisputeInfo { milestone: 0, until: t0 - hour }),
    }
  let own = escrow_in(base, 62_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 {
        ..base,
        dispute: Some(DisputeInfo { milestone: 1, until: t0 + hour }),
      },
      v2_utxo_value(escrow_v2_policy(), 62_000_000),
    )
  validate_raise_dispute(
    escrow_v2_policy(),
    base,
    own,
    0,
    [cont],
    raise_tx(beneficiary_pkh(), [cont]),
  )
}

test raise__rejects_outsider() {
  // The verifier is neither funder nor beneficiary.
  let datum = with_arbiter()
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      raised(datum),
      v2_utxo_value(escrow_v2_policy(), 102_000_000),
    )
  !validate_raise_dispute(
    escrow_v2_policy(),
    datum,
    own,
    0,
    [cont],
    raise_tx(verifier_pkh(), [cont]),
  )
}

test raise__rejects_wrong_until() {
  // Continuation claims a longer freeze than upper + dispute_window.
  let datum = with_arbiter()
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 {
        ..datum,
        dispute: Some(DisputeInfo { milestone: 0, until: t0 + 10 * hour }),
      },
      v2_utxo_value(escrow_v2_policy(), 102_000_000),
    )
  !validate_raise_dispute(
    escrow_v2_policy(),
    datum,
    own,
    0,
    [cont],
    raise_tx(funder_pkh(), [cont]),
  )
}

// ── ResolveDispute ───────────────────────────────────────────────────────────

fn resolve_tx(signer: ByteArray, outputs: List<Output>) -> Transaction {
  Transaction {
    ..placeholder,
    outputs: outputs,
    mint: burn_one(),
    extra_signatories: [signer],
  }
}

test resolve__accepts_arbiter_split() {
  let datum = raised(with_arbiter())
  let own = escrow_in(datum, 102_000_000)
  let outputs =
    [
      user_output(funder_address(), assets.from_lovelace(62_000_000)),
      user_output(beneficiary_address(), assets.from_lovelace(40_000_000)),
    ]
  validate_resolve_dispute(
    escrow_v2_policy(),
    datum,
    own,
    outputs,
    burn_one(),
    resolve_tx(arbiter_pkh(), outputs),
  )
}

test resolve__rejects_non_arbiter() {
  let datum = raised(with_arbiter())
  let own = escrow_in(datum, 102_000_000)
  let outputs =
    [
      user_output(funder_address(), assets.from_lovelace(62_000_000)),
      user_output(beneficiary_address(), assets.from_lovelace(40_000_000)),
    ]
  !validate_resolve_dispute(
    escrow_v2_policy(),
    datum,
    own,
    outputs,
    burn_one(),
    resolve_tx(funder_pkh(), outputs),
  )
}

test resolve__rejects_paying_third_party() {
  // Half the pot leaks to the verifier's address.
  let datum = raised(with_arbiter())
  let own = escrow_in(datum, 102_000_000)
  let verifier_addr = addr.from_verification_key(verifier_pkh())
  let outputs =
    [
      user_output(funder_address(), assets.from_lovelace(52_000_000)),
      user_output(verifier_addr, assets.from_lovelace(50_000_000)),
    ]
  !validate_resolve_dispute(
    escrow_v2_policy(),
    datum,
    own,
    outputs,
    burn_one(),
    resolve_tx(arbiter_pkh(), outputs),
  )
}

test resolve__rejects_without_dispute() fail {
  let datum = with_arbiter()
  let own = escrow_in(datum, 102_000_000)
  let outputs = [user_output(funder_address(), assets.from_lovelace(102_000_000))]
  validate_resolve_dispute(
    escrow_v2_policy(),
    datum,
    own,
    outputs,
    burn_one(),
    resolve_tx(arbiter_pkh(), outputs),
  )
}

test resolve__rejects_stale_dispute_from_prior_milestone() {
  let datum =
    EscrowDatumV2 {
      ..raised(with_arbiter()),
      released_count: 1,
    }
  let own = escrow_in(datum, 62_000_000)
  let outputs = [user_output(funder_address(), assets.from_lovelace(62_000_000))]
  !validate_resolve_dispute(
    escrow_v2_policy(),
    datum,
    own,
    outputs,
    burn_one(),
    resolve_tx(arbiter_pkh(), outputs),
  )
}
