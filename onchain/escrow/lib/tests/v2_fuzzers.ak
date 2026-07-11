use aiken/collection/list
use aiken/fuzz
use cardano/assets
use cardano/transaction.{Output, Transaction, placeholder}
use escrow/escrow_v2_validation.{
  milestones_total, validate_create_escrow_v2, validate_reclaim_v2,
  validate_release_v2,
}
use escrow/types_v2.{EscrowDatumV2, Milestone}
use tests/common.{
  beneficiary_address, escrow_input, funder_address, funder_pkh, range_after,
  range_before, seed_input, seed_token_name, user_output, verifier_pkh,
}
use tests/common_v2.{
  day, escrow_v2_output, escrow_v2_policy, hour, t0, test_v2_datum,
  v2_utxo_value,
}

const m0_cure = 1_800_000_000_000 + 86_400_000 + 3_600_000

// Random valid schedule: 1-8 milestones, positive amounts, strictly increasing
// deadlines built from positive gaps off t0.
fn gen_schedule() -> Fuzzer<List<Milestone>> {
  let pairs <-
    fuzz.and_then(
      fuzz.list_between(
        fuzz.both(
          fuzz.int_between(1, 100_000_000),
          fuzz.int_between(1, day),
        ),
        1,
        8,
      ),
    )
  let (reversed, _) =
    list.foldl(
      pairs,
      ([], t0),
      fn(pair, acc) {
        let (ms, last) = acc
        let (amount, gap) = pair
        ([Milestone { amount, deadline: last + gap }, ..ms], last + gap)
      },
    )
  fuzz.constant(list.reverse(reversed))
}

// Any structurally valid schedule must be creatable when fully funded.
test prop_create_accepts_valid_schedules(milestones via gen_schedule()) {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      milestones: milestones,
      evidence: list.map(milestones, fn(_) { None }),
    }
  let locked = milestones_total(milestones) + 2_000_000
  validate_create_escrow_v2(
    escrow_v2_policy(),
    0,
    0,
    [seed_input()],
    [
      escrow_v2_output(
        escrow_v2_policy(),
        datum,
        v2_utxo_value(escrow_v2_policy(), locked),
      ),
    ],
    assets.from_asset(escrow_v2_policy(), seed_token_name(), 1),
    range_before(t0),
  )
}

// No-race invariant: at ANY probe time t, a release pinned at upper = t and a
// reclaim pinned at lower = t can never both validate.
test prop_release_reclaim_never_both(
  dt via fuzz.int_between(-172_800_000, 172_800_000),
) {
  let t = m0_cure + dt
  let datum = test_v2_datum()
  let own =
    escrow_input(
      0,
      escrow_v2_output(
        escrow_v2_policy(),
        datum,
        v2_utxo_value(escrow_v2_policy(), 102_000_000),
      ),
    )
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 62_000_000),
    )
  let payout: Output =
    user_output(beneficiary_address(), assets.from_lovelace(40_000_000))
  let release_outputs = [cont, payout]
  let release_ok =
    validate_release_v2(
      escrow_v2_policy(),
      datum,
      own,
      0,
      1,
      99,
      release_outputs,
      assets.zero,
      Transaction {
        ..placeholder,
        outputs: release_outputs,
        extra_signatories: [verifier_pkh()],
        validity_range: range_before(t),
      },
    )
  let refund = user_output(funder_address(), assets.from_lovelace(102_000_000))
  let burn = assets.from_asset(escrow_v2_policy(), seed_token_name(), -1)
  let reclaim_ok =
    validate_reclaim_v2(
      escrow_v2_policy(),
      datum,
      own,
      0,
      [refund],
      burn,
      Transaction {
        ..placeholder,
        outputs: [refund],
        mint: burn,
        extra_signatories: [funder_pkh()],
        validity_range: range_after(t),
      },
    )
  !(release_ok && reclaim_ok)
}

// hour is referenced by m0_cure's derivation; keep the import meaningful.
test prop_cure_constant_matches_datum() {
  let datum = test_v2_datum()
  expect Some(first) = list.head(datum.milestones)
  first.deadline + datum.grace == m0_cure && hour == datum.grace
}
