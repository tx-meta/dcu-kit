use cardano/address as addr
use cardano/assets
use cardano/transaction.{Transaction, placeholder}
use escrow/escrow_validation.{only_own_input, validate_abort, validate_reclaim}
use escrow/types.{EscrowDatum}
use tests/common.{
  beneficiary_address, beneficiary_pkh, escrow_input, escrow_output,
  escrow_policy, escrow_utxo_value, funder_address, funder_pkh, range_after,
  seed_token_name, test_escrow_datum, token_policy, user_output,
}

const expiry = 1_800_000_000_000

fn funder_script_hash() {
  #"f5c81f75c81f75c81f75c81f75c81f75c81f75c81f75c81f75c81f75"
}

fn burn() {
  assets.from_asset(escrow_policy(), seed_token_name(), -1)
}

// Escrow mid-schedule: tranche 0 already released, 62 ADA remaining.
fn mid_datum() {
  EscrowDatum { ..test_escrow_datum(), released_count: 1 }
}

fn mid_input() {
  escrow_input(
    0,
    escrow_output(
      escrow_policy(),
      mid_datum(),
      escrow_utxo_value(escrow_policy(), 62_000_000),
    ),
  )
}

fn funder_signed_after(t: Int) -> Transaction {
  Transaction {
    ..placeholder,
    extra_signatories: [funder_pkh()],
    validity_range: range_after(t),
    mint: burn(),
  }
}

test reclaim__after_expiry_mid_schedule_accepted() {
  let refund = user_output(funder_address(), assets.from_lovelace(62_000_000))
  validate_reclaim(
    escrow_policy(),
    mid_datum(),
    mid_input(),
    0,
    [refund],
    burn(),
    funder_signed_after(expiry + 1),
  )
}

test reclaim__native_token_remainder_accepted() {
  let datum = EscrowDatum {
    ..mid_datum(),
    asset_policy: token_policy(),
    asset_name: "USDM",
    milestones: [500, 300, 200],
  }
  let own = escrow_input(
    0,
    escrow_output(
      escrow_policy(),
      datum,
      escrow_utxo_value(escrow_policy(), 2_000_000)
        |> assets.add(token_policy(), "USDM", 500),
    ),
  )
  let refund = user_output(
    funder_address(),
    assets.from_lovelace(2_000_000) |> assets.add(token_policy(), "USDM", 500),
  )
  validate_reclaim(
    escrow_policy(),
    datum,
    own,
    0,
    [refund],
    burn(),
    funder_signed_after(expiry + 1),
  )
}

test reclaim__script_funder_via_spent_input_accepted() {
  let datum = EscrowDatum {
    ..mid_datum(),
    funder: addr.from_script(funder_script_hash()),
  }
  let refund = user_output(
    addr.from_script(funder_script_hash()),
    assets.from_lovelace(62_000_000),
  )
  let dust = escrow_input(
    7,
    user_output(
      addr.from_script(funder_script_hash()),
      assets.from_lovelace(2_000_000),
    ),
  )
  let tx = Transaction {
    ..placeholder,
    inputs: [mid_input(), dust],
    validity_range: range_after(expiry + 1),
    mint: burn(),
  }
  validate_reclaim(escrow_policy(), datum, mid_input(), 0, [refund], burn(), tx)
}

test reclaim__before_expiry_rejected() {
  let refund = user_output(funder_address(), assets.from_lovelace(62_000_000))
  !validate_reclaim(
    escrow_policy(),
    mid_datum(),
    mid_input(),
    0,
    [refund],
    burn(),
    funder_signed_after(expiry - 1),
  )
}

test reclaim__at_expiry_rejected() {
  let refund = user_output(funder_address(), assets.from_lovelace(62_000_000))
  !validate_reclaim(
    escrow_policy(),
    mid_datum(),
    mid_input(),
    0,
    [refund],
    burn(),
    funder_signed_after(expiry),
  )
}

test reclaim__without_funder_auth_rejected() {
  let refund = user_output(funder_address(), assets.from_lovelace(62_000_000))
  let tx = Transaction {
    ..placeholder,
    extra_signatories: [beneficiary_pkh()],
    validity_range: range_after(expiry + 1),
    mint: burn(),
  }
  !validate_reclaim(
    escrow_policy(),
    mid_datum(),
    mid_input(),
    0,
    [refund],
    burn(),
    tx,
  )
}

test reclaim__refund_to_non_funder_rejected() {
  let refund = user_output(
    beneficiary_address(),
    assets.from_lovelace(62_000_000),
  )
  !validate_reclaim(
    escrow_policy(),
    mid_datum(),
    mid_input(),
    0,
    [refund],
    burn(),
    funder_signed_after(expiry + 1),
  )
}

test reclaim__short_refund_rejected() {
  let refund = user_output(funder_address(), assets.from_lovelace(61_999_999))
  !validate_reclaim(
    escrow_policy(),
    mid_datum(),
    mid_input(),
    0,
    [refund],
    burn(),
    funder_signed_after(expiry + 1),
  )
}

test reclaim__without_burn_rejected() {
  let refund = user_output(funder_address(), assets.from_lovelace(62_000_000))
  let tx = Transaction {
    ..placeholder,
    extra_signatories: [funder_pkh()],
    validity_range: range_after(expiry + 1),
  }
  !validate_reclaim(
    escrow_policy(),
    mid_datum(),
    mid_input(),
    0,
    [refund],
    assets.zero,
    tx,
  )
}

// No Finite lower bound: the expect errors.
test reclaim__unbounded_lower_rejected() fail {
  let refund = user_output(funder_address(), assets.from_lovelace(62_000_000))
  let tx = Transaction {
    ..placeholder,
    extra_signatories: [funder_pkh()],
    mint: burn(),
  }
  validate_reclaim(
    escrow_policy(),
    mid_datum(),
    mid_input(),
    0,
    [refund],
    burn(),
    tx,
  )
}

test abort__co_signed_accepted() {
  let tx = Transaction {
    ..placeholder,
    extra_signatories: [funder_pkh(), beneficiary_pkh()],
    mint: burn(),
  }
  validate_abort(escrow_policy(), mid_datum(), mid_input(), burn(), tx)
}

test abort__script_funder_plus_vk_beneficiary_accepted() {
  let datum = EscrowDatum {
    ..mid_datum(),
    funder: addr.from_script(funder_script_hash()),
  }
  let dust = escrow_input(
    7,
    user_output(
      addr.from_script(funder_script_hash()),
      assets.from_lovelace(2_000_000),
    ),
  )
  let tx = Transaction {
    ..placeholder,
    inputs: [mid_input(), dust],
    extra_signatories: [beneficiary_pkh()],
    mint: burn(),
  }
  validate_abort(escrow_policy(), datum, mid_input(), burn(), tx)
}

test abort__funder_only_rejected() {
  let tx = Transaction {
    ..placeholder,
    extra_signatories: [funder_pkh()],
    mint: burn(),
  }
  !validate_abort(escrow_policy(), mid_datum(), mid_input(), burn(), tx)
}

test abort__beneficiary_only_rejected() {
  let tx = Transaction {
    ..placeholder,
    extra_signatories: [beneficiary_pkh()],
    mint: burn(),
  }
  !validate_abort(escrow_policy(), mid_datum(), mid_input(), burn(), tx)
}

test abort__without_burn_rejected() {
  let tx = Transaction {
    ..placeholder,
    extra_signatories: [funder_pkh(), beneficiary_pkh()],
  }
  !validate_abort(escrow_policy(), mid_datum(), mid_input(), assets.zero, tx)
}

// Dispatch-level rule shared by all spend paths: exactly one escrow input per tx.
test only_own_input__single_accepted() {
  only_own_input(escrow_policy(), [mid_input(), tests_dust()])
}

test only_own_input__two_escrow_inputs_rejected() {
  let second = escrow_input(
    1,
    escrow_output(
      escrow_policy(),
      test_escrow_datum(),
      escrow_utxo_value(escrow_policy(), 102_000_000),
    ),
  )
  !only_own_input(escrow_policy(), [mid_input(), second])
}

// A stake-credential appearance of the escrow script must not count as a second
// escrow input (payment credential is the discriminator).
test only_own_input__stake_appearance_not_counted() {
  let stake_side = escrow_input(
    2,
    user_output(
      addr.from_verification_key(funder_pkh())
        |> addr.with_delegation_script(escrow_policy()),
      assets.from_lovelace(5_000_000),
    ),
  )
  only_own_input(escrow_policy(), [mid_input(), stake_side])
}

fn tests_dust() {
  escrow_input(
    9,
    user_output(funder_address(), assets.from_lovelace(5_000_000)),
  )
}
