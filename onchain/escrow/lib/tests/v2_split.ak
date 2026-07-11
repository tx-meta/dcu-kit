use cardano/address as addr
use cardano/assets
use cardano/transaction.{Output, Transaction, placeholder}
use escrow/escrow_v2_validation.{
  validate_create_escrow_v2, validate_release_v2, validate_rotate_party,
}
use escrow/types_v2.{CoBeneficiary, CoBeneficiaryParty, EscrowDatumV2}
use tests/common.{
  beneficiary_address, beneficiary_pkh, escrow_input, funder_pkh, range_before,
  seed_input, seed_token_name, user_output, verifier_pkh,
}
use tests/common_v2.{
  day, escrow_v2_output, escrow_v2_policy, t0, test_v2_datum, v2_utxo_value,
}

fn co_a_pkh() {
  #"aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11"
}

fn co_b_pkh() {
  #"bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22"
}

fn co_a_address() {
  addr.from_verification_key(co_a_pkh())
}

fn co_b_address() {
  addr.from_verification_key(co_b_pkh())
}

// Primary 70% / co A 20% / co B 10%.
fn split_datum() -> EscrowDatumV2 {
  EscrowDatumV2 {
    ..test_v2_datum(),
    co_beneficiaries: [
      CoBeneficiary { address: co_a_address(), share_bps: 2_000 },
      CoBeneficiary { address: co_b_address(), share_bps: 1_000 },
    ],
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

fn create_ok(datum: EscrowDatumV2) -> Bool {
  validate_create_escrow_v2(
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
    assets.from_asset(escrow_v2_policy(), seed_token_name(), 1),
    range_before(t0),
  )
}

test split_create__accepts_valid_shares() {
  create_ok(split_datum())
}

test split_create__rejects_shares_at_or_over_10000() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      co_beneficiaries: [
        CoBeneficiary { address: co_a_address(), share_bps: 6_000 },
        CoBeneficiary { address: co_b_address(), share_bps: 4_000 },
      ],
    }
  !create_ok(datum)
}

test split_create__rejects_zero_share() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      co_beneficiaries: [
        CoBeneficiary { address: co_a_address(), share_bps: 0 },
      ],
    }
  !create_ok(datum)
}

test split_create__rejects_duplicate_co_address() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      co_beneficiaries: [
        CoBeneficiary { address: co_a_address(), share_bps: 1_000 },
        CoBeneficiary { address: co_a_address(), share_bps: 1_000 },
      ],
    }
  !create_ok(datum)
}

test split_create__rejects_co_equal_to_primary() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      co_beneficiaries: [
        CoBeneficiary { address: beneficiary_address(), share_bps: 1_000 },
      ],
    }
  !create_ok(datum)
}

test split_create__rejects_verifier_as_co_beneficiary() {
  let datum =
    EscrowDatumV2 {
      ..test_v2_datum(),
      co_beneficiaries: [
        CoBeneficiary {
          address: addr.from_verification_key(verifier_pkh()),
          share_bps: 1_000,
        },
      ],
    }
  !create_ok(datum)
}

// Release of the 40 ADA first tranche: co A gets 8, co B gets 4, primary 28.
fn split_release(outputs: List<Output>) -> Bool {
  let datum = split_datum()
  let own = escrow_in(datum, 102_000_000)
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

fn split_cont() -> Output {
  escrow_v2_output(
    escrow_v2_policy(),
    EscrowDatumV2 { ..split_datum(), released_count: 1 },
    v2_utxo_value(escrow_v2_policy(), 62_000_000),
  )
}

test split_release__accepts_correct_split() {
  split_release(
    [
      split_cont(),
      user_output(beneficiary_address(), assets.from_lovelace(28_000_000)),
      user_output(co_a_address(), assets.from_lovelace(8_000_000)),
      user_output(co_b_address(), assets.from_lovelace(4_000_000)),
    ],
  )
}

test split_release__rejects_shorted_co_beneficiary() {
  // Co A receives 5 instead of 8; the primary pockets the difference.
  !split_release(
    [
      split_cont(),
      user_output(beneficiary_address(), assets.from_lovelace(31_000_000)),
      user_output(co_a_address(), assets.from_lovelace(5_000_000)),
      user_output(co_b_address(), assets.from_lovelace(4_000_000)),
    ],
  )
}

test split_release__rejects_missing_co_output() {
  !split_release(
    [
      split_cont(),
      user_output(beneficiary_address(), assets.from_lovelace(36_000_000)),
      user_output(co_b_address(), assets.from_lovelace(4_000_000)),
    ],
  )
}

test split_release__rejects_shorted_primary() {
  // Everything to the cos, primary shorted below tranche - co cuts.
  !split_release(
    [
      split_cont(),
      user_output(beneficiary_address(), assets.from_lovelace(20_000_000)),
      user_output(co_a_address(), assets.from_lovelace(16_000_000)),
      user_output(co_b_address(), assets.from_lovelace(4_000_000)),
    ],
  )
}

test split_rotate__accepts_co_self_rotation() {
  let datum = split_datum()
  let own = escrow_in(datum, 102_000_000)
  let new_addr =
    addr.from_verification_key(
      #"cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33",
    )
  let rotated =
    EscrowDatumV2 {
      ..datum,
      co_beneficiaries: [
        CoBeneficiary { address: new_addr, share_bps: 2_000 },
        CoBeneficiary { address: co_b_address(), share_bps: 1_000 },
      ],
    }
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      rotated,
      v2_utxo_value(escrow_v2_policy(), 102_000_000),
    )
  validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    CoBeneficiaryParty { index: 0 },
    [cont],
    Transaction {
      ..placeholder,
      outputs: [cont],
      extra_signatories: [co_a_pkh()],
      validity_range: range_before(t0),
    },
  )
}

test split_rotate__rejects_co_rotation_by_primary() {
  let datum = split_datum()
  let own = escrow_in(datum, 102_000_000)
  let new_addr =
    addr.from_verification_key(
      #"cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33",
    )
  let rotated =
    EscrowDatumV2 {
      ..datum,
      co_beneficiaries: [
        CoBeneficiary { address: new_addr, share_bps: 2_000 },
        CoBeneficiary { address: co_b_address(), share_bps: 1_000 },
      ],
    }
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      rotated,
      v2_utxo_value(escrow_v2_policy(), 102_000_000),
    )
  !validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    CoBeneficiaryParty { index: 0 },
    [cont],
    Transaction {
      ..placeholder,
      outputs: [cont],
      extra_signatories: [beneficiary_pkh()],
      validity_range: range_before(t0),
    },
  )
}

test split_rotate__rejects_share_change_in_rotation() {
  let datum = split_datum()
  let own = escrow_in(datum, 102_000_000)
  let rotated =
    EscrowDatumV2 {
      ..datum,
      co_beneficiaries: [
        CoBeneficiary { address: co_a_address(), share_bps: 5_000 },
        CoBeneficiary { address: co_b_address(), share_bps: 1_000 },
      ],
    }
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      rotated,
      v2_utxo_value(escrow_v2_policy(), 102_000_000),
    )
  !validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    CoBeneficiaryParty { index: 0 },
    [cont],
    Transaction {
      ..placeholder,
      outputs: [cont],
      extra_signatories: [co_a_pkh()],
      validity_range: range_before(t0),
    },
  )
}

test split_release__single_beneficiary_unchanged() {
  // Empty co list reproduces exactly the old behavior.
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont =
    escrow_v2_output(
      escrow_v2_policy(),
      EscrowDatumV2 { ..datum, released_count: 1 },
      v2_utxo_value(escrow_v2_policy(), 62_000_000),
    )
  let outputs =
    [cont, user_output(beneficiary_address(), assets.from_lovelace(40_000_000))]
  validate_release_v2(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    99,
    outputs,
    assets.zero,
    Transaction {
      ..placeholder,
      outputs: outputs,
      extra_signatories: [verifier_pkh()],
      validity_range: range_before(t0 + day),
    },
  )
}

// funder_pkh imported for parity with other suites; reference it once.
test split__funder_key_sanity() {
  funder_pkh() != verifier_pkh()
}
