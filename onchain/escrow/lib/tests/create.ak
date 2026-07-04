use aiken/collection/list
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{Output}
use escrow/escrow_validation.{
  milestones_total, validate_burn_escrow, validate_create_escrow,
}
use escrow/types.{EscrowDatum}
use tests/common.{
  beneficiary_address, escrow_address, escrow_output, escrow_policy,
  escrow_utxo_value, range_before, seed_input, seed_token_name,
  test_escrow_datum, token_policy,
}

// Locked value: 100 ADA milestones + 2 ADA min-ADA buffer, plus the state token.
fn default_create_value() {
  escrow_utxo_value(escrow_policy(), 102_000_000)
}

fn default_mint() {
  assets.from_asset(escrow_policy(), seed_token_name(), 1)
}

const test_expiry = 1_800_000_000_000

fn create_accepts(datum: EscrowDatum, value) {
  validate_create_escrow(
    escrow_policy(),
    0,
    0,
    [seed_input()],
    [escrow_output(escrow_policy(), datum, value)],
    default_mint(),
    range_before(test_expiry - 1),
  )
}

test create__ada_escrow_accepted() {
  create_accepts(test_escrow_datum(), default_create_value())
}

test create__native_token_escrow_accepted() {
  let datum = EscrowDatum {
    ..test_escrow_datum(),
    asset_policy: token_policy(),
    asset_name: "USDM",
    milestones: [500, 300, 200],
  }
  let value = escrow_utxo_value(escrow_policy(), 2_000_000)
    |> assets.add(token_policy(), "USDM", 1_000)
  create_accepts(datum, value)
}

test create__single_milestone_prepayment_accepted() {
  let datum = EscrowDatum { ..test_escrow_datum(), milestones: [100_000_000] }
  create_accepts(datum, default_create_value())
}

test create__wrong_token_name_rejected() {
  let mint = assets.from_asset(escrow_policy(), "not-the-seed-name", 1)
  !validate_create_escrow(
    escrow_policy(),
    0,
    0,
    [seed_input()],
    [
      escrow_output(
        escrow_policy(),
        test_escrow_datum(),
        default_create_value(),
      ),
    ],
    mint,
    range_before(test_expiry - 1),
  )
}

// Two tokens of the policy in one mint: the exactly-one destructure errors.
test create__two_tokens_minted_rejected() fail {
  let mint = assets.from_asset(escrow_policy(), seed_token_name(), 1)
    |> assets.add(escrow_policy(), "second-token", 1)
  validate_create_escrow(
    escrow_policy(),
    0,
    0,
    [seed_input()],
    [
      escrow_output(
        escrow_policy(),
        test_escrow_datum(),
        default_create_value(),
      ),
    ],
    mint,
    range_before(test_expiry - 1),
  )
}

test create__output_at_foreign_address_rejected() {
  let out = escrow_output(
    escrow_policy(),
    test_escrow_datum(),
    default_create_value(),
  )
  let foreign = Output { ..out, address: beneficiary_address() }
  !validate_create_escrow(
    escrow_policy(),
    0,
    0,
    [seed_input()],
    [foreign],
    default_mint(),
    range_before(test_expiry - 1),
  )
}

test create__state_token_missing_from_output_rejected() {
  !validate_create_escrow(
    escrow_policy(),
    0,
    0,
    [seed_input()],
    [
      escrow_output(
        escrow_policy(),
        test_escrow_datum(),
        assets.from_lovelace(102_000_000),
      ),
    ],
    default_mint(),
    range_before(test_expiry - 1),
  )
}

test create__nonzero_released_count_rejected() {
  let datum = EscrowDatum { ..test_escrow_datum(), released_count: 1 }
  !create_accepts(datum, default_create_value())
}

test create__empty_milestones_rejected() {
  let datum = EscrowDatum { ..test_escrow_datum(), milestones: [] }
  !create_accepts(datum, default_create_value())
}

test create__zero_milestone_rejected() {
  let datum = EscrowDatum {
    ..test_escrow_datum(),
    milestones: [40_000_000, 0, 20_000_000],
  }
  !create_accepts(datum, default_create_value())
}

test create__negative_milestone_rejected() {
  let datum = EscrowDatum {
    ..test_escrow_datum(),
    milestones: [80_000_000, -30_000_000, 50_000_000],
  }
  !create_accepts(datum, default_create_value())
}

test create__underfunded_value_rejected() {
  !create_accepts(
    test_escrow_datum(),
    escrow_utxo_value(escrow_policy(), 99_999_999),
  )
}

test create__funder_is_own_script_rejected() {
  let datum = EscrowDatum {
    ..test_escrow_datum(),
    funder: escrow_address(escrow_policy()),
  }
  !create_accepts(datum, default_create_value())
}

test create__verifier_is_own_script_rejected() {
  let datum = EscrowDatum {
    ..test_escrow_datum(),
    verifier: Script(escrow_policy()),
  }
  !create_accepts(datum, default_create_value())
}

test create__milestone_list_over_cap_rejected() {
  let datum = EscrowDatum {
    ..test_escrow_datum(),
    milestones: list.repeat(1_000, 101),
  }
  !create_accepts(datum, default_create_value())
}

test create__milestone_list_at_cap_accepted() {
  let datum = EscrowDatum {
    ..test_escrow_datum(),
    milestones: list.repeat(1_000, 100),
  }
  !create_accepts(datum, escrow_utxo_value(escrow_policy(), 99_999)) && create_accepts(
    datum,
    escrow_utxo_value(escrow_policy(), 100_000),
  )
}

// Creation at or past expiry is rejected: the tx's pinned upper bound must sit
// strictly below the datum's expiry.
test create__at_or_past_expiry_rejected() {
  let datum = test_escrow_datum()
  !validate_create_escrow(
    escrow_policy(),
    0,
    0,
    [seed_input()],
    [escrow_output(escrow_policy(), datum, default_create_value())],
    default_mint(),
    range_before(test_expiry),
  )
}

// Create without a Finite upper bound: the expect errors.
test create__unbounded_upper_rejected() fail {
  let datum = test_escrow_datum()
  validate_create_escrow(
    escrow_policy(),
    0,
    0,
    [seed_input()],
    [escrow_output(escrow_policy(), datum, default_create_value())],
    default_mint(),
    common_unbounded(),
  )
}

fn common_unbounded() {
  transaction.placeholder.validity_range
}

test milestones_total__sums() {
  milestones_total([40_000_000, 40_000_000, 20_000_000]) == 100_000_000
}

test burn__all_negative_accepted() {
  validate_burn_escrow(
    escrow_policy(),
    assets.from_asset(escrow_policy(), seed_token_name(), -1),
  )
}

test burn__positive_quantity_rejected() {
  let mint = assets.from_asset(escrow_policy(), seed_token_name(), -1)
    |> assets.add(escrow_policy(), "sneaky-mint", 1)
  !validate_burn_escrow(escrow_policy(), mint)
}

test burn__nothing_of_policy_rejected() {
  !validate_burn_escrow(
    escrow_policy(),
    assets.from_asset(token_policy(), "USDM", -5),
  )
}
