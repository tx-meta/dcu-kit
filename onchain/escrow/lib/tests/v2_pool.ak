use cardano/address.{VerificationKey}
use cardano/address as addr
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, Transaction, placeholder,
}
use escrow/pool_validation.{
  validate_allocate, validate_burn_pool, validate_close_pool,
  validate_create_pool, validate_exit_deposit, validate_update_pool,
}
use escrow/types_pool.{PoolAnchor, PoolDatum, PoolDeposit, VaultDatum}
use tests/common.{
  escrow_input, funder_address, funder_pkh, range_after, range_before,
  seed_input, seed_token_name, verifier_pkh,
}
use tests/common_v2.{escrow_v2_policy, hour, t0}

fn vault_policy() {
  #"a0010a0010a0010a0010a0010a0010a0010a0010a0010a0010a0010a"
}

fn quorum_pkh() {
  #"e0e1e2e3e4e5e6e7e8e9eaebecedeeefe0e1e2e3e4e5e6e7e8e9eaeb"
}

fn test_pool() -> PoolDatum {
  PoolDatum {
    title: "seed round pool",
    content_hash: None,
    quorum: VerificationKey(quorum_pkh()),
    escrow_target: escrow_v2_policy(),
    asset_policy: assets.ada_policy_id,
    asset_name: assets.ada_asset_name,
    funding_deadline: Some(t0 + hour),
    status: 0,
  }
}

fn anchor_output(pool: PoolDatum) -> Output {
  let data: Data = PoolAnchor { pool }
  Output {
    address: addr.from_script(vault_policy()),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(vault_policy(), seed_token_name(), 1),
    datum: InlineDatum(data),
    reference_script: None,
  }
}

fn deposit_datum() -> VaultDatum {
  PoolDeposit {
    pool_id: seed_token_name(),
    contributor: funder_address(),
    locked_until: None,
  }
}

fn deposit_output(datum: VaultDatum, lovelace: Int) -> Output {
  let data: Data = datum
  Output {
    address: addr.from_script(vault_policy()),
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(data),
    reference_script: None,
  }
}

fn escrow_out(lovelace: Int) -> Output {
  Output {
    address: addr.from_script(escrow_v2_policy()),
    value: assets.from_lovelace(lovelace)
      |> assets.add(escrow_v2_policy(), "e5c0", 1),
    datum: NoDatum,
    reference_script: None,
  }
}

fn pool_ref() -> Input {
  Input {
    output_reference: common.seed_ref(),
    output: anchor_output(test_pool()),
  }
}

// ── Create / burn ────────────────────────────────────────────────────────────

test pool_create__accepts_valid() {
  validate_create_pool(
    vault_policy(),
    0,
    0,
    [seed_input()],
    [anchor_output(test_pool())],
    assets.from_asset(vault_policy(), seed_token_name(), 1),
  )
}

test pool_create__rejects_closed_status() {
  let pool = PoolDatum { ..test_pool(), status: 1 }
  !validate_create_pool(
    vault_policy(),
    0,
    0,
    [seed_input()],
    [anchor_output(pool)],
    assets.from_asset(vault_policy(), seed_token_name(), 1),
  )
}

test pool_create__rejects_self_targeting() {
  let pool = PoolDatum { ..test_pool(), escrow_target: vault_policy() }
  !validate_create_pool(
    vault_policy(),
    0,
    0,
    [seed_input()],
    [anchor_output(pool)],
    assets.from_asset(vault_policy(), seed_token_name(), 1),
  )
}

test pool_burn__rejects_mint_alongside() {
  !validate_burn_pool(
    vault_policy(),
    assets.from_asset(vault_policy(), seed_token_name(), -1)
      |> assets.add(vault_policy(), "extra", 1),
  )
}

// ── Update / close ───────────────────────────────────────────────────────────

test pool_update__accepts_quorum_rotation() {
  let pool = test_pool()
  let own = escrow_input(0, anchor_output(pool))
  let rotated = PoolDatum { ..pool, quorum: VerificationKey(verifier_pkh()) }
  let cont = anchor_output(rotated)
  validate_update_pool(
    vault_policy(),
    pool,
    own,
    0,
    [cont],
    Transaction { ..placeholder, extra_signatories: [quorum_pkh()] },
  )
}

test pool_update__rejects_non_quorum() {
  let pool = test_pool()
  let own = escrow_input(0, anchor_output(pool))
  let cont = anchor_output(PoolDatum { ..pool, title: "hijacked" })
  !validate_update_pool(
    vault_policy(),
    pool,
    own,
    0,
    [cont],
    Transaction { ..placeholder, extra_signatories: [funder_pkh()] },
  )
}

test pool_update__rejects_target_change() {
  let pool = test_pool()
  let own = escrow_input(0, anchor_output(pool))
  let cont =
    anchor_output(
      PoolDatum {
        ..pool,
        escrow_target: #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      },
    )
  !validate_update_pool(
    vault_policy(),
    pool,
    own,
    0,
    [cont],
    Transaction { ..placeholder, extra_signatories: [quorum_pkh()] },
  )
}

test pool_close__accepts_quorum_burn() {
  let pool = test_pool()
  let own = escrow_input(0, anchor_output(pool))
  let burn = assets.from_asset(vault_policy(), seed_token_name(), -1)
  validate_close_pool(
    vault_policy(),
    pool,
    own,
    burn,
    Transaction {
      ..placeholder,
      mint: burn,
      extra_signatories: [quorum_pkh()],
    },
  )
}

// ── Exit ─────────────────────────────────────────────────────────────────────

test pool_exit__accepts_contributor() {
  validate_exit_deposit(
    funder_address(),
    None,
    Transaction { ..placeholder, extra_signatories: [funder_pkh()] },
  )
}

test pool_exit__rejects_non_contributor() {
  !validate_exit_deposit(
    funder_address(),
    None,
    Transaction { ..placeholder, extra_signatories: [quorum_pkh()] },
  )
}

test pool_exit__rejects_before_lock_expiry() fail {
  validate_exit_deposit(
    funder_address(),
    Some(t0 + hour),
    Transaction { ..placeholder, extra_signatories: [funder_pkh()] },
  )
}

test pool_exit__accepts_after_lock_expiry() {
  validate_exit_deposit(
    funder_address(),
    Some(t0 + hour),
    Transaction {
      ..placeholder,
      extra_signatories: [funder_pkh()],
      validity_range: range_after(t0 + hour + 1),
    },
  )
}

// ── Allocate ─────────────────────────────────────────────────────────────────

fn allocate(
  deposit_lovelace: Int,
  outputs: List<Output>,
  escrow_input_index: Int,
  continuation_index: Int,
  inputs: List<Input>,
  signer: ByteArray,
) -> Bool {
  let datum = deposit_datum()
  let raw: Data = datum
  let own = escrow_input(0, deposit_output(datum, deposit_lovelace))
  validate_allocate(
    vault_policy(),
    raw,
    seed_token_name(),
    own,
    0,
    0,
    escrow_input_index,
    continuation_index,
    inputs,
    [pool_ref()],
    outputs,
    Transaction {
      ..placeholder,
      outputs: outputs,
      extra_signatories: [signer],
      validity_range: range_before(t0),
    },
  )
}

test pool_allocate__accepts_seeding_new_escrow() {
  // Whole 100 ADA deposit becomes a new escrow.
  allocate(100_000_000, [escrow_out(100_000_000)], 99, 99, [], quorum_pkh())
}

test pool_allocate__rejects_non_quorum() {
  !allocate(100_000_000, [escrow_out(100_000_000)], 99, 99, [], funder_pkh())
}

test pool_allocate__rejects_value_leak() {
  // Only 60 of the 100 ADA reaches the escrow; 40 leaks to the crank.
  !allocate(100_000_000, [escrow_out(60_000_000)], 99, 99, [], quorum_pkh())
}

test pool_allocate__accepts_partial_with_continuation() {
  let cont = deposit_output(deposit_datum(), 40_000_000)
  allocate(
    100_000_000,
    [escrow_out(60_000_000), cont],
    99,
    1,
    [],
    quorum_pkh(),
  )
}

test pool_allocate__rejects_continuation_datum_swap() {
  // Remainder re-tagged to a different contributor.
  let swapped =
    PoolDeposit {
      pool_id: seed_token_name(),
      contributor: addr.from_verification_key(quorum_pkh()),
      locked_until: None,
    }
  let cont = deposit_output(swapped, 40_000_000)
  !allocate(
    100_000_000,
    [escrow_out(60_000_000), cont],
    99,
    1,
    [],
    quorum_pkh(),
  )
}

test pool_allocate__accepts_contribute_to_existing_escrow() {
  // Escrow already holds 50; deposit adds 100 → output 150.
  let esc_in = escrow_input(1, escrow_out(50_000_000))
  allocate(
    100_000_000,
    [escrow_out(150_000_000)],
    1,
    99,
    [escrow_input(0, deposit_output(deposit_datum(), 100_000_000)), esc_in],
    quorum_pkh(),
  )
}

test pool_allocate__rejects_contribute_short_gain() {
  // Escrow gains only 30 of the 100 allocated.
  let esc_in = escrow_input(1, escrow_out(50_000_000))
  !allocate(
    100_000_000,
    [escrow_out(80_000_000)],
    1,
    99,
    [escrow_input(0, deposit_output(deposit_datum(), 100_000_000)), esc_in],
    quorum_pkh(),
  )
}

test pool_allocate__rejects_past_funding_deadline() {
  let datum = deposit_datum()
  let raw: Data = datum
  let own = escrow_input(0, deposit_output(datum, 100_000_000))
  !validate_allocate(
    vault_policy(),
    raw,
    seed_token_name(),
    own,
    0,
    0,
    99,
    99,
    [],
    [pool_ref()],
    [escrow_out(100_000_000)],
    Transaction {
      ..placeholder,
      outputs: [escrow_out(100_000_000)],
      extra_signatories: [quorum_pkh()],
      validity_range: range_before(t0 + 2 * hour),
    },
  )
}

test pool_allocate__rejects_closed_pool() {
  let datum = deposit_datum()
  let raw: Data = datum
  let own = escrow_input(0, deposit_output(datum, 100_000_000))
  let closed_ref =
    Input {
      output_reference: common.seed_ref(),
      output: anchor_output(PoolDatum { ..test_pool(), status: 1 }),
    }
  !validate_allocate(
    vault_policy(),
    raw,
    seed_token_name(),
    own,
    0,
    0,
    99,
    99,
    [],
    [closed_ref],
    [escrow_out(100_000_000)],
    Transaction {
      ..placeholder,
      outputs: [escrow_out(100_000_000)],
      extra_signatories: [quorum_pkh()],
      validity_range: range_before(t0),
    },
  )
}

test pool_allocate__rejects_wrong_destination_script() fail {
  // Output sits at the vault itself, not the escrow target.
  let datum = deposit_datum()
  let raw: Data = datum
  let own = escrow_input(0, deposit_output(datum, 100_000_000))
  let wrong =
    Output {
      address: addr.from_script(vault_policy()),
      value: assets.from_lovelace(100_000_000),
      datum: NoDatum,
      reference_script: None,
    }
  validate_allocate(
    vault_policy(),
    raw,
    seed_token_name(),
    own,
    0,
    0,
    99,
    99,
    [],
    [pool_ref()],
    [wrong],
    Transaction {
      ..placeholder,
      outputs: [wrong],
      extra_signatories: [quorum_pkh()],
      validity_range: range_before(t0),
    },
  )
}
