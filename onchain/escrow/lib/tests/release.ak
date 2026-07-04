use cardano/address.{Script}
use cardano/address as addr
use cardano/assets
use cardano/transaction.{NoDatum, Output, Transaction, placeholder}
use escrow/escrow_validation.{validate_release}
use escrow/types.{EscrowDatum}
use tests/common.{
  beneficiary_address, beneficiary_pkh, escrow_input, escrow_output,
  escrow_policy, escrow_utxo_value, funder_address, funder_pkh, range_before,
  seed_token_name, stake_pkh, test_escrow_datum, token_policy, user_output,
  verifier_pkh,
}

const expiry = 1_800_000_000_000

fn verifier_script_hash() {
  #"5c81f75c81f75c81f75c81f75c81f75c81f75c81f75c81f75c81f75c"
}

// Escrow UTxO holding the remaining balance for `datum`, tranche payout to the
// beneficiary, and (for non-final releases) a continuation with the advanced count.
fn escrow_in(datum: EscrowDatum, lovelace: Int) {
  escrow_input(
    0,
    escrow_output(
      escrow_policy(),
      datum,
      escrow_utxo_value(escrow_policy(), lovelace),
    ),
  )
}

fn payout(amount: Int) -> Output {
  user_output(beneficiary_address(), assets.from_lovelace(amount))
}

fn signed_tx(outputs: List<Output>) -> Transaction {
  Transaction {
    ..placeholder,
    outputs,
    extra_signatories: [verifier_pkh()],
    validity_range: range_before(expiry - 1),
  }
}

test release__first_tranche_accepted() {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    signed_tx([cont, payout(40_000_000)]),
  )
}

test release__middle_tranche_accepted() {
  let datum = EscrowDatum { ..test_escrow_datum(), released_count: 1 }
  let own = escrow_in(datum, 62_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 2 },
    escrow_utxo_value(escrow_policy(), 22_000_000),
  )
  validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    signed_tx([cont, payout(40_000_000)]),
  )
}

test release__final_tranche_burns_token() {
  let datum = EscrowDatum { ..test_escrow_datum(), released_count: 2 }
  let own = escrow_in(datum, 22_000_000)
  let burn = assets.from_asset(escrow_policy(), seed_token_name(), -1)
  let tx = Transaction {
    ..placeholder,
    outputs: [payout(20_000_000)],
    mint: burn,
    extra_signatories: [verifier_pkh()],
    validity_range: range_before(expiry - 1),
  }
  validate_release(
    escrow_policy(),
    datum,
    own,
    99,
    0,
    [payout(20_000_000)],
    burn,
    tx,
  )
}

test release__script_verifier_via_spent_input_accepted() {
  let datum = EscrowDatum {
    ..test_escrow_datum(),
    verifier: Script(verifier_script_hash()),
  }
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  let dust = escrow_input(
    7,
    user_output(
      addr.from_script(verifier_script_hash()),
      assets.from_lovelace(2_000_000),
    ),
  )
  let tx = Transaction {
    ..placeholder,
    inputs: [own, dust],
    outputs: [cont, payout(40_000_000)],
    validity_range: range_before(expiry - 1),
  }
  validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    tx,
  )
}

test release__native_token_tranche_preserves_lovelace() {
  let datum = EscrowDatum {
    ..test_escrow_datum(),
    asset_policy: token_policy(),
    asset_name: "USDM",
    milestones: [500, 300, 200],
  }
  let in_value = escrow_utxo_value(escrow_policy(), 2_000_000)
    |> assets.add(token_policy(), "USDM", 1_000)
  let own = escrow_input(0, escrow_output(escrow_policy(), datum, in_value))
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 2_000_000)
      |> assets.add(token_policy(), "USDM", 500),
  )
  let out = user_output(
    beneficiary_address(),
    assets.from_lovelace(1_500_000) |> assets.add(token_policy(), "USDM", 500),
  )
  validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, out],
    assets.zero,
    signed_tx([cont, out]),
  )
}

test release__missing_verifier_signature_rejected() {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  let tx = Transaction {
    ..placeholder,
    outputs: [cont, payout(40_000_000)],
    validity_range: range_before(expiry - 1),
  }
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    tx,
  )
}

test release__short_payout_rejected() {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(39_999_999)],
    assets.zero,
    signed_tx([cont, payout(39_999_999)]),
  )
}

test release__payout_to_wrong_address_rejected() {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  let wrong = user_output(funder_address(), assets.from_lovelace(40_000_000))
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, wrong],
    assets.zero,
    signed_tx([cont, wrong]),
  )
}

// Beneficiary payment credential with a swapped stake credential must reject —
// the datum pins the FULL address.
test release__payout_stake_credential_swap_rejected() {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  let skimmed = user_output(
    addr.from_verification_key(beneficiary_pkh())
      |> addr.with_delegation_key(funder_pkh()),
    assets.from_lovelace(40_000_000),
  )
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, skimmed],
    assets.zero,
    signed_tx([cont, skimmed]),
  )
}

test release__released_count_jump_rejected() {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 2 },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    signed_tx([cont, payout(40_000_000)]),
  )
}

test release__milestone_mutation_rejected() {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum {
      ..datum,
      released_count: 1,
      milestones: [40_000_000, 60_000_000, 20_000_000],
    },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    signed_tx([cont, payout(40_000_000)]),
  )
}

test release__continuation_at_foreign_address_rejected() {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont0 = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  let cont = Output { ..cont0, address: funder_address() }
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    signed_tx([cont, payout(40_000_000)]),
  )
}

test release__continuation_missing_state_token_rejected() {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    assets.from_lovelace(62_000_000),
  )
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    signed_tx([cont, payout(40_000_000)]),
  )
}

test release__continuation_value_short_rejected() {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 61_999_999),
  )
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    signed_tx([cont, payout(40_000_000)]),
  )
}

test release__final_without_burn_rejected() {
  let datum = EscrowDatum { ..test_escrow_datum(), released_count: 2 }
  let own = escrow_in(datum, 22_000_000)
  !validate_release(
    escrow_policy(),
    datum,
    own,
    99,
    0,
    [payout(20_000_000)],
    assets.zero,
    signed_tx([payout(20_000_000)]),
  )
}

test release__after_expiry_rejected() {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  let tx = Transaction {
    ..placeholder,
    outputs: [cont, payout(40_000_000)],
    extra_signatories: [verifier_pkh()],
    validity_range: range_before(expiry + 1),
  }
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    tx,
  )
}

// No Finite upper bound (default unbounded validity): the expect errors.
test release__unbounded_upper_rejected() fail {
  let datum = test_escrow_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  let tx = Transaction {
    ..placeholder,
    outputs: [cont, payout(40_000_000)],
    extra_signatories: [verifier_pkh()],
  }
  validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    tx,
  )
}

// The verifier script hash appearing only as a stake credential of a spent input
// must not authorize the release.
test release__script_verifier_stake_only_rejected() {
  let datum = EscrowDatum {
    ..test_escrow_datum(),
    verifier: Script(verifier_script_hash()),
  }
  let own = escrow_in(datum, 102_000_000)
  let cont = escrow_output(
    escrow_policy(),
    EscrowDatum { ..datum, released_count: 1 },
    escrow_utxo_value(escrow_policy(), 62_000_000),
  )
  let stake_only = escrow_input(
    7,
    Output {
      address: addr.from_verification_key(stake_pkh())
        |> addr.with_delegation_script(verifier_script_hash()),
      value: assets.from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  )
  let tx = Transaction {
    ..placeholder,
    inputs: [own, stake_only],
    outputs: [cont, payout(40_000_000)],
    validity_range: range_before(expiry - 1),
  }
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout(40_000_000)],
    assets.zero,
    tx,
  )
}
