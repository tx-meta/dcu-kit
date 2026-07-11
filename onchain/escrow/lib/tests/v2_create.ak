use cardano/address.{Script, VerificationKey}
use cardano/assets
use escrow/escrow_v2_validation.{validate_burn_escrow_v2, validate_create_escrow_v2}
use escrow/types_v2.{DisputeInfo, EscrowDatumV2, Milestone, PerMilestone}
use tests/common.{
  beneficiary_pkh, funder_pkh, range_before, seed_input, seed_token_name,
  verifier_pkh,
}
use tests/common_v2.{
  arbiter_pkh, day, escrow_v2_output, escrow_v2_policy, hour, t0, test_v2_datum,
  v2_utxo_value,
}

fn mint_one() {
  assets.from_asset(escrow_v2_policy(), seed_token_name(), 1)
}

// Creation happens comfortably before the first deadline.
fn create_range() {
  range_before(t0)
}

fn create_ok(datum: EscrowDatumV2, lovelace: Int) -> Bool {
  validate_create_escrow_v2(
    escrow_v2_policy(),
    0,
    0,
    [seed_input()],
    [
      escrow_v2_output(
        escrow_v2_policy(),
        datum,
        v2_utxo_value(escrow_v2_policy(), lovelace),
      ),
    ],
    mint_one(),
    create_range(),
  )
}

test create_v2__accepts_valid_upfront() {
  // 100 ADA total + 2 ADA buffer.
  create_ok(test_v2_datum(), 102_000_000)
}

test create_v2__accepts_per_milestone_buffer_only() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), funding_mode: PerMilestone }
  create_ok(datum, 2_000_000)
}

test create_v2__accepts_arbiter() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      arbiter: Some(VerificationKey(arbiter_pkh())),
    }
  create_ok(datum, 102_000_000)
}

test create_v2__rejects_upfront_underfunded() {
  // 100 ADA of milestones but only 50 ADA locked.
  !create_ok(test_v2_datum(), 50_000_000)
}

test create_v2__rejects_per_milestone_below_buffer() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), funding_mode: PerMilestone }
  !create_ok(datum, 1_000_000)
}

test create_v2__rejects_non_monotonic_deadlines() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      milestones: [
        Milestone { amount: 40_000_000, deadline: t0 + 2 * day },
        Milestone { amount: 40_000_000, deadline: t0 + 1 * day },
        Milestone { amount: 20_000_000, deadline: t0 + 3 * day },
      ],
    }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_equal_deadlines() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      milestones: [
        Milestone { amount: 40_000_000, deadline: t0 + day },
        Milestone { amount: 60_000_000, deadline: t0 + day },
      ],
      evidence: [None, None],
    }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_zero_amount_milestone() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      milestones: [
        Milestone { amount: 0, deadline: t0 + day },
        Milestone { amount: 100_000_000, deadline: t0 + 2 * day },
      ],
      evidence: [None, None],
    }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_empty_milestones() fail {
  let datum =
    EscrowDatumV2 { ..test_v2_datum(), milestones: [], evidence: [] }
  create_ok(datum, 102_000_000)
}

test create_v2__rejects_verifier_equals_beneficiary() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      verifier: VerificationKey(beneficiary_pkh()),
    }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_arbiter_equals_funder() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      arbiter: Some(VerificationKey(funder_pkh())),
    }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_arbiter_equals_verifier() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      arbiter: Some(VerificationKey(verifier_pkh())),
    }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_preexisting_dispute() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      dispute: Some(DisputeInfo { milestone: 0, until: t0 + day }),
    }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_nonzero_released_count() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), released_count: 1 }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_evidence_length_mismatch() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), evidence: [None, None] }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_prefilled_evidence() {
  let datum =
    EscrowDatumV2 { ..test_v2_datum(), evidence: [Some("deed"), None, None] }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_negative_grace() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), grace: -1 }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_negative_dispute_window() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), dispute_window: -1 }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_born_past_first_cure() {
  // Upper bound sits past deadline[0] + grace — born already timed out.
  let datum = test_v2_datum()
  !validate_create_escrow_v2(
    escrow_v2_policy(),
    0,
    0,
    [seed_input()],
    [
      escrow_v2_output(
        escrow_v2_policy(),
        datum,
        v2_utxo_value(escrow_v2_policy(), 102_000_000),
      ),
    ],
    mint_one(),
    common.range_before(t0 + day + hour + 1),
  )
}

test create_v2__rejects_own_script_funder() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      funder: common_v2.escrow_v2_address(escrow_v2_policy()),
    }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_own_script_verifier() {
  let datum =
    EscrowDatumV2 { ..test_v2_datum(), verifier: Script(escrow_v2_policy()) }
  !create_ok(datum, 102_000_000)
}

test create_v2__rejects_wrong_token_name() fail {
  // Minted name does not match the seed derivation.
  validate_create_escrow_v2(
    escrow_v2_policy(),
    0,
    0,
    [seed_input()],
    [
      escrow_v2_output(
        escrow_v2_policy(),
        test_v2_datum(),
        v2_utxo_value(escrow_v2_policy(), 102_000_000),
      ),
    ],
    assets.from_asset(escrow_v2_policy(), "bogus", 1),
    create_range(),
  )
}

test burn_v2__accepts_pure_burn() {
  validate_burn_escrow_v2(
    escrow_v2_policy(),
    assets.from_asset(escrow_v2_policy(), seed_token_name(), -1),
  )
}

test burn_v2__rejects_mint_alongside_burn() {
  !validate_burn_escrow_v2(
    escrow_v2_policy(),
    assets.from_asset(escrow_v2_policy(), seed_token_name(), -1)
      |> assets.add(escrow_v2_policy(), "extra", 1),
  )
}
