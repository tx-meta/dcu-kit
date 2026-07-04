//// Efficiency probe: full Release validation at increasing milestone counts.
//// Not a correctness suite — run `aiken check -m tests/scale_probe` and read the
//// per-test execution_units. Expected O(len(milestones)); budget 14M mem / 10B cpu.

use aiken/collection/list
use cardano/assets
use cardano/transaction.{Transaction, placeholder}
use escrow/escrow_validation.{milestones_total, validate_release}
use escrow/types.{EscrowDatum}
use tests/common.{
  escrow_input, escrow_output, escrow_policy, escrow_utxo_value, range_before,
  seed_token_name as common_token_name, test_escrow_datum, user_output,
  verifier_pkh,
}

const expiry = 1_800_000_000_000

// Mid-schedule release (worst list traversal: released_count = n/2) over an
// n-tranche ADA escrow.
fn release_at_n(n: Int) -> Bool {
  let milestones = list.repeat(10_000_000, n)
  let released_count = n / 2
  let datum = EscrowDatum { ..test_escrow_datum(), milestones, released_count }
  let remaining = milestones_total(list.drop(milestones, released_count))
  let own = escrow_input(
    0,
    escrow_output(
      escrow_policy(),
      datum,
      escrow_utxo_value(escrow_policy(), remaining + 2_000_000),
    ),
  )
  let payout = user_output(datum.beneficiary, assets.from_lovelace(10_000_000))
  let is_final = released_count + 1 == n
  if is_final {
    let burn = assets.from_asset(escrow_policy(), common_token_name(), -1)
    let tx = Transaction {
      ..placeholder,
      outputs: [payout],
      mint: burn,
      extra_signatories: [verifier_pkh()],
      validity_range: range_before(expiry - 1),
    }
    validate_release(escrow_policy(), datum, own, 99, 0, [payout], burn, tx)
  } else {
    let cont = escrow_output(
      escrow_policy(),
      EscrowDatum { ..datum, released_count: released_count + 1 },
      escrow_utxo_value(escrow_policy(), remaining - 10_000_000 + 2_000_000),
    )
    let tx = Transaction {
      ..placeholder,
      outputs: [cont, payout],
      extra_signatories: [verifier_pkh()],
      validity_range: range_before(expiry - 1),
    }
    validate_release(
      escrow_policy(),
      datum,
      own,
      0,
      1,
      [cont, payout],
      assets.zero,
      tx,
    )
  }
}

test scale_release_n1() {
  release_at_n(1)
}

test scale_release_n5() {
  release_at_n(5)
}

test scale_release_n10() {
  release_at_n(10)
}

test scale_release_n20() {
  release_at_n(20)
}

test scale_release_n50() {
  release_at_n(50)
}
