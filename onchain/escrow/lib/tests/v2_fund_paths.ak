use cardano/assets
use cardano/transaction.{Output, Transaction, placeholder}
use escrow/escrow_v2_validation.{
  validate_reclaim_v2, validate_release_v2, validate_timeout_release,
}
use escrow/types_v2.{
  DisputeInfo, EscrowDatumV2, PerMilestone, ReleaseToBeneficiary,
}
use tests/common.{
  beneficiary_address, escrow_input, funder_address, funder_pkh, range_after,
  range_before, seed_token_name, user_output, verifier_pkh,
}
use tests/common_v2.{
  day, escrow_v2_output, escrow_v2_policy, hour, range_between, t0,
  test_v2_datum, v2_utxo_value,
}

// Milestone 0: deadline t0 + 1d, grace 1h → cure boundary t0 + 1d + 1h.
const m0_cure = 1_800_000_000_000 + 86_400_000 + 3_600_000

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

fn payout(amount: Int) -> Output {
  user_output(beneficiary_address(), assets.from_lovelace(amount))
}

fn funder_out(amount: Int) -> Output {
  user_output(funder_address(), assets.from_lovelace(amount))
}

fn burn_one() {
  assets.from_asset(escrow_v2_policy(), seed_token_name(), -1)
}

// ── Release ──────────────────────────────────────────────────────────────────

test release_v2__accepts_first_tranche() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 62_000_000),
    )
  let outputs = [cont, payout(40_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      extra_signatories: [verifier_pkh()],
      validity_range: range_before(t0 + day),
    }
  validate_release_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    tx,
  )
}

test release_v2__accepts_final_with_funder_remainder() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), released_count: 2 }
  let own = escrow_in(datum, 22_000_000)
  let outputs = [payout(20_000_000), funder_out(2_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      mint: burn_one(),
      extra_signatories: [verifier_pkh()],
      validity_range: range_before(t0 + 3 * day),
    }
  validate_release_v2(
    escrow_v2_policy(),
    datum,
    own,
    99,
    0,
    1,
    outputs,
    burn_one(),
    tx,
  )
}

test release_v2__rejects_final_without_funder_remainder() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), released_count: 2 }
  let own = escrow_in(datum, 22_000_000)
  // funder_index points at the beneficiary payout — no output to the funder.
  let outputs = [payout(20_000_000), payout(2_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      mint: burn_one(),
      extra_signatories: [verifier_pkh()],
      validity_range: range_before(t0 + 3 * day),
    }
  !validate_release_v2(
    escrow_v2_policy(),
    datum,
    own,
    99,
    0,
    1,
    outputs,
    burn_one(),
    tx,
  )
}

test release_v2__rejects_after_cure() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 62_000_000),
    )
  let outputs = [cont, payout(40_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      extra_signatories: [verifier_pkh()],
      validity_range: range_before(m0_cure + 1),
    }
  !validate_release_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    tx,
  )
}

test release_v2__rejects_missing_verifier_signature() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 62_000_000),
    )
  let outputs = [cont, payout(40_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      extra_signatories: [funder_pkh()],
      validity_range: range_before(t0 + day),
    }
  !validate_release_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    tx,
  )
}

test release_v2__rejects_underfunded_per_milestone() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), funding_mode: PerMilestone }
  // Only the 2 ADA buffer is locked — the 40 ADA tranche is not funded.
  let own = escrow_in(datum, 2_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 2_000_000),
    )
  let outputs = [cont, payout(40_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      extra_signatories: [verifier_pkh()],
      validity_range: range_before(t0 + day),
    }
  !validate_release_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    tx,
  )
}

test release_v2__accepts_funded_per_milestone() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), funding_mode: PerMilestone }
  // Tranche + buffer contributed before release.
  let own = escrow_in(datum, 42_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 2_000_000),
    )
  let outputs = [cont, payout(40_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      extra_signatories: [verifier_pkh()],
      validity_range: range_before(t0 + day),
    }
  validate_release_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    tx,
  )
}

test release_v2__rejects_while_dispute_frozen() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      dispute: Some(DisputeInfo { milestone: 0, until: t0 + 2 * hour }),
    }
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 62_000_000),
    )
  let outputs = [cont, payout(40_000_000)]
  // Lower bound sits inside the freeze (<= until).
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      extra_signatories: [verifier_pkh()],
      validity_range: range_between(t0 + hour, t0 + day),
    }
  !validate_release_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    tx,
  )
}

test release_v2__accepts_in_extended_window_after_dispute() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      dispute: Some(DisputeInfo { milestone: 0, until: t0 + 2 * hour }),
    }
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 62_000_000),
    )
  let outputs = [cont, payout(40_000_000)]
  // Past the base cure boundary but inside the dispute-extended window; the
  // freeze has lapsed (lower > until).
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      extra_signatories: [verifier_pkh()],
      validity_range: range_between(t0 + 3 * hour, m0_cure + hour / 2),
    }
  validate_release_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    tx,
  )
}

// ── TimeoutRelease ───────────────────────────────────────────────────────────

test timeout_v2__accepts_after_cure_without_signatures() {
  let datum =
    EscrowDatumV2 { ..test_v2_datum(), timeout_policy: ReleaseToBeneficiary }
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 62_000_000),
    )
  let outputs = [cont, payout(40_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      validity_range: range_after(m0_cure + 1),
    }
  validate_timeout_release(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    tx,
  )
}

test timeout_v2__rejects_before_cure() {
  let datum =
    EscrowDatumV2 { ..test_v2_datum(), timeout_policy: ReleaseToBeneficiary }
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 62_000_000),
    )
  let outputs = [cont, payout(40_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      validity_range: range_after(t0 + day),
    }
  !validate_timeout_release(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    tx,
  )
}

test timeout_v2__rejects_refund_mode() {
  // RefundToFunder escrows have no auto-release path.
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 62_000_000),
    )
  let outputs = [cont, payout(40_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      validity_range: range_after(m0_cure + 1),
    }
  !validate_timeout_release(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    tx,
  )
}

test timeout_v2__rejects_underfunded_per_milestone() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      timeout_policy: ReleaseToBeneficiary,
      funding_mode: PerMilestone,
    }
  let own = escrow_in(datum, 2_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 2_000_000),
    )
  let outputs = [cont, payout(40_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      validity_range: range_after(m0_cure + 1),
    }
  !validate_timeout_release(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    tx,
  )
}

test timeout_v2__accepts_final_returns_remainder_to_funder() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      timeout_policy: ReleaseToBeneficiary,
      released_count: 2,
    }
  let own = escrow_in(datum, 22_000_000)
  let outputs = [payout(20_000_000), funder_out(2_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      mint: burn_one(),
      validity_range: range_after(t0 + 3 * day + hour + 1),
    }
  validate_timeout_release(
    escrow_v2_policy(),
    datum,
    own,
    99,
    0,
    1,
    outputs,
    burn_one(),
    tx,
  )
}

// ── Reclaim ──────────────────────────────────────────────────────────────────

fn reclaim_tx(outputs: List<Output>, lower: Int) -> Transaction {
  Transaction {
    ..placeholder,
    outputs: outputs,
    mint: burn_one(),
    extra_signatories: [funder_pkh()],
    validity_range: range_after(lower),
  }
}

test reclaim_v2__accepts_after_cure() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let outputs = [funder_out(102_000_000)]
  validate_reclaim_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    outputs,
    burn_one(),
    reclaim_tx(outputs, m0_cure + 1),
  )
}

test reclaim_v2__rejects_release_to_beneficiary_mode() {
  let datum =
    EscrowDatumV2 { ..test_v2_datum(), timeout_policy: ReleaseToBeneficiary }
  let own = escrow_in(datum, 102_000_000)
  let outputs = [funder_out(102_000_000)]
  !validate_reclaim_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    outputs,
    burn_one(),
    reclaim_tx(outputs, m0_cure + 1),
  )
}

test reclaim_v2__rejects_before_cure() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let outputs = [funder_out(102_000_000)]
  !validate_reclaim_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    outputs,
    burn_one(),
    reclaim_tx(outputs, t0 + day),
  )
}

test reclaim_v2__rejects_missing_funder_signature() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let outputs = [funder_out(102_000_000)]
  let tx =
    Transaction {
      ..placeholder,
      outputs: outputs,
      mint: burn_one(),
      extra_signatories: [verifier_pkh()],
      validity_range: range_after(m0_cure + 1),
    }
  !validate_reclaim_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    outputs,
    burn_one(),
    tx,
  )
}

test reclaim_v2__rejects_inside_dispute_extension() {
  // Milestone 0 was disputed: cure extends by dispute_window. A reclaim at the
  // base boundary must fail even though the freeze itself has lapsed.
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      dispute: Some(DisputeInfo { milestone: 0, until: t0 + 2 * hour }),
    }
  let own = escrow_in(datum, 102_000_000)
  let outputs = [funder_out(102_000_000)]
  !validate_reclaim_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    outputs,
    burn_one(),
    reclaim_tx(outputs, m0_cure + 1),
  )
}

test reclaim_v2__rejects_short_refund() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let outputs = [funder_out(50_000_000)]
  !validate_reclaim_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    outputs,
    burn_one(),
    reclaim_tx(outputs, m0_cure + 1),
  )
}
