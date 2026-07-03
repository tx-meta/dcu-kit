//// Mutual reserve (Cluster C) — creation one-shot, top-ups, levies, stand-in
//// cover, wind-down refunds. Spec: 2026-07-03-cluster-c-reserve-design.md

use cardano/assets
use cardano/transaction.{Transaction}
use dcu/cip68
use dcu/reserve.{group_reserve_minted, validate_create_reserve}
use dcu/treasury.{ReserveState}
use tests/common

// ─── Shared test helpers ──────────────────────────────────────────────────────

// Distinct policy IDs for treasury and group (mirrors lib/tests/treasury.ak).
fn treasury_policy() -> assets.PolicyId {
  common.test_hash_01()
}

fn group_policy() -> assets.PolicyId {
  common.test_hash_02()
}

// Derived CIP-68 group names from the canonical seed ref, so prefix checks hold.
fn group_ref_tn() -> assets.AssetName {
  let (_output_ref, ref_tn, _user_tn) = common.setup_cip68(group_policy())
  ref_tn
}

fn group_user_tn() -> assets.AssetName {
  let (_output_ref, _ref_tn, user_tn) = common.setup_cip68(group_policy())
  user_tn
}

fn reserve_tn() -> assets.AssetName {
  cip68.convert_ref_to_reserve_token(group_ref_tn())
}

// The full create-tx mint: group ref + user under the group policy, reserve
// token under the treasury policy.
fn create_mint() -> assets.Value {
  assets.from_asset(group_policy(), group_ref_tn(), 1)
    |> assets.merge(assets.from_asset(group_policy(), group_user_tn(), 1))
    |> assets.merge(assets.from_asset(treasury_policy(), reserve_tn(), 1))
}

// Reserve output value at creation: min-ADA + the reserve token.
fn reserve_create_value() -> assets.Value {
  assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(treasury_policy(), reserve_tn(), 1))
}

// The freshly-created group UTxO at the group script, holding the ref token.
fn group_create_output() {
  common.test_script_utxo(
    group_policy(),
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(group_policy(), group_ref_tn(), 1)),
    common.test_group_cip68_datum(group_policy()),
  )
}

fn reserve_output(
  binding: assets.AssetName,
  standin: Int,
  value: assets.Value,
) {
  common.test_script_utxo(
    treasury_policy(),
    value,
    ReserveState { group_reference_tokenname: binding, standin_rounds: standin },
  )
}

fn create_reserve_tx(
  binding: assets.AssetName,
  standin: Int,
  reserve_value: assets.Value,
  mint: assets.Value,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    outputs: [group_create_output(), reserve_output(binding, standin, reserve_value)],
    mint: mint,
  }
}

// ─── CreateReserve: PASS ──────────────────────────────────────────────────────

test create_reserve__success() {
  let tx = create_reserve_tx(
    group_ref_tn(),
    0,
    reserve_create_value(),
    create_mint(),
  )
  validate_create_reserve(treasury_policy(), group_policy(), 0, 1, tx)
}

// ─── CreateReserve: FAIL ──────────────────────────────────────────────────────

// One-shot violation: the group ref token exists in the output but is NOT being
// minted (an already-existing group cannot gain a second reserve).
test create_reserve__rejects_unminted_group_ref() {
  let mint_without_group = assets.from_asset(
    treasury_policy(),
    reserve_tn(),
    1,
  )
  let tx = create_reserve_tx(
    group_ref_tn(),
    0,
    reserve_create_value(),
    mint_without_group,
  )
  !validate_create_reserve(treasury_policy(), group_policy(), 0, 1, tx)
}

// Reserve token name must be prefix_rsv + the group ref's unique part.
test create_reserve__rejects_wrong_reserve_name() {
  let wrong_tn = cip68.convert_ref_to_user_token(group_ref_tn())
  let mint = assets.from_asset(group_policy(), group_ref_tn(), 1)
    |> assets.merge(assets.from_asset(group_policy(), group_user_tn(), 1))
    |> assets.merge(assets.from_asset(treasury_policy(), wrong_tn, 1))
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(treasury_policy(), wrong_tn, 1))
  let tx = create_reserve_tx(group_ref_tn(), 0, value, mint)
  !validate_create_reserve(treasury_policy(), group_policy(), 0, 1, tx)
}

// Exactly ONE token may be minted under the treasury policy at creation.
test create_reserve__rejects_extra_treasury_mint() {
  let mint = create_mint()
    |> assets.merge(assets.from_asset(treasury_policy(), #"deadbeef", 1))
  let tx = create_reserve_tx(group_ref_tn(), 0, reserve_create_value(), mint)
  !validate_create_reserve(treasury_policy(), group_policy(), 0, 1, tx)
}

// The datum must bind to the group being created.
test create_reserve__rejects_wrong_binding() {
  let tx = create_reserve_tx(
    #"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd",
    0,
    reserve_create_value(),
    create_mint(),
  )
  !validate_create_reserve(treasury_policy(), group_policy(), 0, 1, tx)
}

// The stand-in counter starts at zero.
test create_reserve__rejects_nonzero_standin() {
  let tx = create_reserve_tx(
    group_ref_tn(),
    3,
    reserve_create_value(),
    create_mint(),
  )
  !validate_create_reserve(treasury_policy(), group_policy(), 0, 1, tx)
}

// The reserve output must sit at the treasury script.
test create_reserve__rejects_wrong_address() {
  let stray = common.test_user_utxo(
    common.test_pkh(),
    reserve_create_value(),
    ReserveState {
      group_reference_tokenname: group_ref_tn(),
      standin_rounds: 0,
    },
  )
  let tx = Transaction {
    ..transaction.placeholder,
    outputs: [group_create_output(), stray],
    mint: create_mint(),
  }
  !validate_create_reserve(treasury_policy(), group_policy(), 0, 1, tx)
}

// Only ADA + the reserve token may sit in the reserve at creation.
test create_reserve__rejects_foreign_assets() {
  let dirty = reserve_create_value()
    |> assets.merge(assets.from_asset(group_policy(), #"cafe", 1))
  let tx = create_reserve_tx(group_ref_tn(), 0, dirty, create_mint())
  !validate_create_reserve(treasury_policy(), group_policy(), 0, 1, tx)
}

// The group output must sit at the TRUSTED group script — a forged group at an
// attacker script (correct token names under a fake policy) crashes the
// trusted-address expect.
test create_reserve__rejects_untrusted_group_address() fail {
  let fake_policy = common.test_hash_03()
  let forged_group = common.test_script_utxo(
    fake_policy,
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(fake_policy, group_ref_tn(), 1)),
    common.test_group_cip68_datum(fake_policy),
  )
  let tx = Transaction {
    ..transaction.placeholder,
    outputs: [forged_group, reserve_output(group_ref_tn(), 0, reserve_create_value())],
    mint: create_mint(),
  }
  validate_create_reserve(treasury_policy(), group_policy(), 0, 1, tx)
}

// The group output's group-policy token must be a (100) ref token.
test create_reserve__rejects_non_ref_group_token() fail {
  let group_output_user_token = common.test_script_utxo(
    group_policy(),
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(group_policy(), group_user_tn(), 1)),
    common.test_group_cip68_datum(group_policy()),
  )
  let tx = Transaction {
    ..transaction.placeholder,
    outputs: [
      group_output_user_token,
      reserve_output(group_ref_tn(), 0, reserve_create_value()),
    ],
    mint: create_mint(),
  }
  validate_create_reserve(treasury_policy(), group_policy(), 0, 1, tx)
}

// ─── group_reserve_minted (group-side coupling) ───────────────────────────────

test group_reserve_minted__accepts_correct_mint() {
  let (output_ref, _ref_tn, _user_tn) = common.setup_cip68(group_policy())
  let seed = common.test_input(
    output_ref,
    common.test_user_utxo(common.test_pkh(), assets.from_lovelace(5_000_000), 0),
  )
  group_reserve_minted(treasury_policy(), seed, create_mint())
}

test group_reserve_minted__rejects_missing_reserve_mint() {
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(group_policy())
  let seed = common.test_input(
    output_ref,
    common.test_user_utxo(common.test_pkh(), assets.from_lovelace(5_000_000), 0),
  )
  let group_only_mint = assets.from_asset(group_policy(), ref_tn, 1)
    |> assets.merge(assets.from_asset(group_policy(), user_tn, 1))
  !group_reserve_minted(treasury_policy(), seed, group_only_mint)
}

test group_reserve_minted__rejects_wrong_name() {
  let (output_ref, _ref_tn, _user_tn) = common.setup_cip68(group_policy())
  let seed = common.test_input(
    output_ref,
    common.test_user_utxo(common.test_pkh(), assets.from_lovelace(5_000_000), 0),
  )
  // A reserve-prefixed token whose unique part does NOT belong to this group's
  // seed — the coupling must reject it.
  let wrong_name = cip68.convert_ref_to_reserve_token(
    #"000643b0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  )
  let mint = create_mint()
    |> assets.merge(
        assets.from_asset(treasury_policy(), reserve_tn(), -1),
      )
    |> assets.merge(assets.from_asset(treasury_policy(), wrong_name, 1))
  !group_reserve_minted(treasury_policy(), seed, mint)
}
