//// Mutual reserve (Cluster C) — creation one-shot, top-ups, levies, stand-in
//// cover, wind-down refunds. Spec: 2026-07-03-cluster-c-reserve-design.md

use aiken/fuzz
use cardano/address
use cardano/assets
use cardano/transaction.{Transaction}
use dcu/cip68
use dcu/group.{GroupCip68Datum, GroupDatum}
use dcu/reserve.{
  group_reserve_minted, validate_create_reserve, validate_reserve_close,
  validate_reserve_cover, validate_reserve_refund, validate_reserve_topup,
}
use dcu/settings
use dcu/treasury.{DefaultState, ReserveState, TreasuryDatum}
use dcu/treasury_actions.{run_reserve_action}
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

fn reserve_output(binding: assets.AssetName, standin: Int, value: assets.Value) {
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
    outputs: [
      group_create_output(),
      reserve_output(binding, standin, reserve_value),
    ],
    mint,
  }
}

// The group's contribution asset per common.test_group_datum(group_policy()):
// policy = group_policy(), assetname = "".
fn contribution(amount: Int) -> assets.Value {
  assets.from_asset(group_policy(), "", amount)
}

// The bound group as a REFERENCE input (standalone reserve operations).
fn group_ref_input() {
  common.test_input(
    transaction.OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    group_create_output(),
  )
}

fn reserve_utxo_ref() -> transaction.OutputReference {
  transaction.OutputReference {
    transaction_id: #"2222222222222222222222222222222222222222222222222222222222222222",
    output_index: 0,
  }
}

fn reserve_input(standin: Int, value: assets.Value) {
  common.test_input(
    reserve_utxo_ref(),
    reserve_output(group_ref_tn(), standin, value),
  )
}

fn reserve_state(standin: Int) -> TreasuryDatum {
  ReserveState {
    group_reference_tokenname: group_ref_tn(),
    standin_rounds: standin,
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
  let mint_without_group = assets.from_asset(treasury_policy(), reserve_tn(), 1)
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
    outputs: [
      forged_group,
      reserve_output(group_ref_tn(), 0, reserve_create_value()),
    ],
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

// ─── ReserveTopUp ─────────────────────────────────────────────────────────────

// Canonical top-up: reserve holds min-ADA + token + 500 contribution units; the
// output adds 300 more. Group rides as a reference input.
fn topup_tx(
  out_binding: assets.AssetName,
  out_standin: Int,
  out_value: assets.Value,
) -> Transaction {
  let in_value = reserve_create_value() |> assets.merge(contribution(500))
  Transaction {
    ..transaction.placeholder,
    inputs: [reserve_input(0, in_value)],
    reference_inputs: [group_ref_input()],
    outputs: [
      common.test_script_utxo(
        treasury_policy(),
        out_value,
        ReserveState {
          group_reference_tokenname: out_binding,
          standin_rounds: out_standin,
        },
      ),
    ],
  }
}

fn topup_out_value(extra: Int) -> assets.Value {
  reserve_create_value() |> assets.merge(contribution(500 + extra))
}

test reserve_topup__accepts_growth() {
  let tx = topup_tx(group_ref_tn(), 0, topup_out_value(300))
  validate_reserve_topup(
    treasury_policy(),
    group_policy(),
    0,
    0,
    reserve_state(0),
    reserve_utxo_ref(),
    tx,
  )
}

// The bound group may also be a SPENDING input (the join-tx shape).
test reserve_topup__accepts_group_as_spending_input() {
  let in_value = reserve_create_value() |> assets.merge(contribution(500))
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [reserve_input(0, in_value), group_ref_input()],
    outputs: [
      common.test_script_utxo(
        treasury_policy(),
        topup_out_value(300),
        reserve_state(0),
      ),
    ],
  }
  validate_reserve_topup(
    treasury_policy(),
    group_policy(),
    0,
    0,
    reserve_state(0),
    reserve_utxo_ref(),
    tx,
  )
}

// No growth = not a top-up.
test reserve_topup__rejects_no_growth() {
  let tx = topup_tx(group_ref_tn(), 0, topup_out_value(0))
  !validate_reserve_topup(
    treasury_policy(),
    group_policy(),
    0,
    0,
    reserve_state(0),
    reserve_utxo_ref(),
    tx,
  )
}

// Nothing can leave through this redeemer.
test reserve_topup__rejects_decrease() {
  let tx = topup_tx(group_ref_tn(), 0, topup_out_value(-200))
  !validate_reserve_topup(
    treasury_policy(),
    group_policy(),
    0,
    0,
    reserve_state(0),
    reserve_utxo_ref(),
    tx,
  )
}

// Datum is frozen — the stand-in counter cannot move here.
test reserve_topup__rejects_standin_tamper() {
  let tx = topup_tx(group_ref_tn(), 1, topup_out_value(300))
  !validate_reserve_topup(
    treasury_policy(),
    group_policy(),
    0,
    0,
    reserve_state(0),
    reserve_utxo_ref(),
    tx,
  )
}

// Datum is frozen — the group binding cannot move here.
test reserve_topup__rejects_binding_tamper() {
  let tx = topup_tx(
    #"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd",
    0,
    topup_out_value(300),
  )
  !validate_reserve_topup(
    treasury_policy(),
    group_policy(),
    0,
    0,
    reserve_state(0),
    reserve_utxo_ref(),
    tx,
  )
}

// The continuation must stay at the reserve's own (full) address.
test reserve_topup__rejects_address_change() {
  let in_value = reserve_create_value() |> assets.merge(contribution(500))
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [reserve_input(0, in_value)],
    reference_inputs: [group_ref_input()],
    outputs: [
      common.test_user_utxo(
        common.test_pkh(),
        topup_out_value(300),
        reserve_state(0),
      ),
    ],
  }
  !validate_reserve_topup(
    treasury_policy(),
    group_policy(),
    0,
    0,
    reserve_state(0),
    reserve_utxo_ref(),
    tx,
  )
}

// The reserve token must ride along.
test reserve_topup__rejects_token_strip() {
  let stripped = assets.from_lovelace(2_000_000)
    |> assets.merge(contribution(800))
  let tx = topup_tx(group_ref_tn(), 0, stripped)
  !validate_reserve_topup(
    treasury_policy(),
    group_policy(),
    0,
    0,
    reserve_state(0),
    reserve_utxo_ref(),
    tx,
  )
}

// Only ADA + the reserve token + the contribution asset may live in the pot.
test reserve_topup__rejects_foreign_asset() {
  let dirty = topup_out_value(300)
    |> assets.merge(assets.from_asset(common.test_hash_03(), #"cafe", 1))
  let tx = topup_tx(group_ref_tn(), 0, dirty)
  !validate_reserve_topup(
    treasury_policy(),
    group_policy(),
    0,
    0,
    reserve_state(0),
    reserve_utxo_ref(),
    tx,
  )
}

// Lovelace can never decrease (native-asset pots would otherwise leak min-ADA).
test reserve_topup__rejects_lovelace_skim() {
  let skimmed = assets.from_lovelace(1_000_000)
    |> assets.merge(assets.from_asset(treasury_policy(), reserve_tn(), 1))
    |> assets.merge(contribution(800))
  let tx = topup_tx(group_ref_tn(), 0, skimmed)
  !validate_reserve_topup(
    treasury_policy(),
    group_policy(),
    0,
    0,
    reserve_state(0),
    reserve_utxo_ref(),
    tx,
  )
}

// Without the bound group present anywhere, the contribution asset cannot be
// authenticated — crash.
test reserve_topup__rejects_missing_group() fail {
  let in_value = reserve_create_value() |> assets.merge(contribution(500))
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [reserve_input(0, in_value)],
    outputs: [
      common.test_script_utxo(
        treasury_policy(),
        topup_out_value(300),
        reserve_state(0),
      ),
    ],
  }
  validate_reserve_topup(
    treasury_policy(),
    group_policy(),
    0,
    0,
    reserve_state(0),
    reserve_utxo_ref(),
    tx,
  )
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
    |> assets.merge(assets.from_asset(treasury_policy(), reserve_tn(), -1))
    |> assets.merge(assets.from_asset(treasury_policy(), wrong_name, 1))
  !group_reserve_minted(treasury_policy(), seed, mint)
}

// ─── ReserveCover (terminate leg) ─────────────────────────────────────────────

fn cover_member_tn() -> assets.AssetName {
  #"eeffeeffeeffeeffeeffeeffeeffeeffeeffeeffeeffeeffeeffeeff"
}

fn wrap_group(datum: GroupDatum) -> Data {
  let wrapped = GroupCip68Datum {
    metadata: [Pair(#"6e616d65", "Test Group")],
    version: 1,
    extra: datum,
  }
  let as_data: Data = wrapped
  as_data
}

// A started group mid-lap: era 0, num_rounds 3, round 0 distributed →
// standin increment = 0 + 3 − (0 + 1) = 2.
fn cover_group_datum() -> GroupDatum {
  GroupDatum {
    ..common.test_group_datum(group_policy()),
    member_count: 1,
    active_member_count: 1,
    is_started: True,
    num_rounds: 3,
    last_distributed_round: 0,
    member_token_names: [cover_member_tn()],
    member_slots: [0],
  }
}

fn cover_group_input() {
  common.test_input(
    transaction.OutputReference {
      transaction_id: #"4444444444444444444444444444444444444444444444444444444444444444",
      output_index: 0,
    },
    common.test_script_utxo(
      group_policy(),
      assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(group_policy(), group_ref_tn(), 1)),
      wrap_group(cover_group_datum()),
    ),
  )
}

fn cover_group_output(member_count: Int) {
  common.test_script_utxo(
    group_policy(),
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(group_policy(), group_ref_tn(), 1)),
    wrap_group(
      GroupDatum {
        ..cover_group_datum(),
        member_count,
        active_member_count: member_count,
        member_token_names: [],
        member_slots: [],
      },
    ),
  )
}

// Defaulter treasury: DefaultState holding 400 contributable units + its token.
fn cover_defaulter_input() {
  common.test_input(
    transaction.OutputReference {
      transaction_id: #"5555555555555555555555555555555555555555555555555555555555555555",
      output_index: 0,
    },
    common.test_script_utxo(
      treasury_policy(),
      assets.from_lovelace(2_000_000)
        |> assets.merge(
            assets.from_asset(treasury_policy(), cover_member_tn(), 1),
          )
        |> assets.merge(contribution(400)),
      DefaultState {
        group_reference_tokenname: group_ref_tn(),
        member_reference_tokenname: cover_member_tn(),
        grace_expires_at: 5000,
        grace_extensions_used: 0,
        rounds_paid: 1,
        member_payment_credential: common.test_pkh(),
        claimable_balance: 0,
      },
    ),
  )
}

fn cover_burn() -> assets.Value {
  assets.from_asset(treasury_policy(), cover_member_tn(), -1)
}

// inputs: group(0), defaulter(1), reserve(2); outputs: group(0), reserve(1).
fn cover_tx(
  reserve_out_extra: Int,
  standin_out: Int,
  burn: assets.Value,
  group_out_count: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      cover_group_input(),
      cover_defaulter_input(),
      reserve_input(
        0,
        reserve_create_value() |> assets.merge(contribution(100)),
      ),
    ],
    outputs: [
      cover_group_output(group_out_count),
      reserve_output(
        group_ref_tn(),
        standin_out,
        reserve_create_value()
          |> assets.merge(contribution(100 + reserve_out_extra)),
      ),
    ],
    mint: burn,
  }
}

fn run_cover(tx: Transaction) -> Bool {
  validate_reserve_cover(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    2,
    1,
    reserve_utxo_ref(),
    tx,
  )
}

// Genuine termination: forfeit 400 lands in the pot, counter 0 → 2 (two
// remaining rounds this lap), member removed, token burned.
test reserve_cover__accepts_genuine_termination() {
  run_cover(cover_tx(400, 2, cover_burn(), 0))
}

// Forfeit not routed (pot grows by less than the defaulter's balance).
test reserve_cover__rejects_unrouted_forfeit() {
  !run_cover(cover_tx(399, 2, cover_burn(), 0))
}

// Stand-in counter must grow by exactly the remaining rounds.
test reserve_cover__rejects_wrong_standin_increment() {
  !run_cover(cover_tx(400, 1, cover_burn(), 0))
}

// No membership-token burn (a Contribute recovery shape) — cover cannot ride it.
test reserve_cover__rejects_without_token_burn() {
  !run_cover(cover_tx(400, 2, assets.zero, 0))
}

// member_count kept (an ExecuteRecovery rotation shape) — cover cannot ride it.
test reserve_cover__rejects_without_member_removal() {
  !run_cover(cover_tx(400, 2, cover_burn(), 1))
}

// ─── ReserveRefund (wind-down equal split) ────────────────────────────────────

// Deactivated 2-member group; one member exits and takes their reserve share.
fn refund_group_datum(member_count: Int) -> GroupDatum {
  GroupDatum {
    ..common.test_group_datum(group_policy()),
    is_active: False,
    member_count,
    active_member_count: member_count,
    member_token_names: [cover_member_tn()],
  }
}

fn refund_group_input() {
  common.test_input(
    transaction.OutputReference {
      transaction_id: #"6666666666666666666666666666666666666666666666666666666666666666",
      output_index: 0,
    },
    common.test_script_utxo(
      group_policy(),
      assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(group_policy(), group_ref_tn(), 1)),
      wrap_group(refund_group_datum(2)),
    ),
  )
}

fn refund_group_output() {
  common.test_script_utxo(
    group_policy(),
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(group_policy(), group_ref_tn(), 1)),
    wrap_group(refund_group_datum(1)),
  )
}

fn refund_exiting_input() {
  common.test_input(
    transaction.OutputReference {
      transaction_id: #"7777777777777777777777777777777777777777777777777777777777777777",
      output_index: 0,
    },
    common.test_script_utxo(
      treasury_policy(),
      assets.from_lovelace(2_000_000)
        |> assets.merge(
            assets.from_asset(treasury_policy(), cover_member_tn(), 1),
          ),
      treasury.TreasuryState {
        group_reference_tokenname: group_ref_tn(),
        member_reference_tokenname: cover_member_tn(),
        rounds_paid: 3,
        member_payment_credential: common.test_pkh(),
        claimable_balance: 0,
      },
    ),
  )
}

// inputs: group(0), exiting treasury(1), reserve(2); outputs: group(0), reserve(1).
// Reserve holds 1000 contribution units; pre-exit member_count = 2 → share 500.
fn refund_tx(taken: Int, active_group: Bool, standin_out: Int) -> Transaction {
  let group_in = if active_group {
    common.test_input(
      transaction.OutputReference {
        transaction_id: #"6666666666666666666666666666666666666666666666666666666666666666",
        output_index: 0,
      },
      common.test_script_utxo(
        group_policy(),
        assets.from_lovelace(2_000_000)
          |> assets.merge(assets.from_asset(group_policy(), group_ref_tn(), 1)),
        wrap_group(GroupDatum { ..refund_group_datum(2), is_active: True }),
      ),
    )
  } else {
    refund_group_input()
  }
  Transaction {
    ..transaction.placeholder,
    inputs: [
      group_in,
      refund_exiting_input(),
      reserve_input(
        0,
        reserve_create_value() |> assets.merge(contribution(1000)),
      ),
    ],
    outputs: [
      refund_group_output(),
      reserve_output(
        group_ref_tn(),
        standin_out,
        reserve_create_value()
          |> assets.merge(contribution(1000 - taken)),
      ),
    ],
  }
}

fn run_refund(tx: Transaction) -> Bool {
  validate_reserve_refund(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    2,
    1,
    reserve_utxo_ref(),
    tx,
  )
}

test reserve_refund__accepts_exact_share() {
  run_refund(refund_tx(500, False, 0))
}

test reserve_refund__accepts_below_share() {
  run_refund(refund_tx(499, False, 0))
}

test reserve_refund__rejects_above_share() {
  !run_refund(refund_tx(501, False, 0))
}

// Voluntary exit while the group is ACTIVE takes nothing from the pot.
test reserve_refund__rejects_active_group() {
  !run_refund(refund_tx(500, True, 0))
}

// Datum frozen — the stand-in counter cannot move through a refund.
test reserve_refund__rejects_standin_tamper() {
  !run_refund(refund_tx(500, False, 1))
}

// Growth through this redeemer is fine to reject too: refund must be >= 0 is
// covered by the top-up path being the only value-in door — a negative "refund"
// (deposit) still validates the bound, so assert the frozen-datum + bound holds.
test reserve_refund__rejects_negative_refund_with_tamper() {
  // taking -100 (depositing) while tampering standin must fail
  !run_refund(refund_tx(-100, False, 1))
}

// ─── ReserveClose (dies with the group) ───────────────────────────────────────

// inputs: group(0), reserve(1). Mint burns group ref + user + reserve token.
fn close_tx(
  member_count: Int,
  burn_group_ref: Bool,
  burn_reserve: Bool,
) -> Transaction {
  let group_in = common.test_input(
    transaction.OutputReference {
      transaction_id: #"8888888888888888888888888888888888888888888888888888888888888888",
      output_index: 0,
    },
    common.test_script_utxo(
      group_policy(),
      assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(group_policy(), group_ref_tn(), 1)),
      wrap_group(
        GroupDatum {
          ..common.test_group_datum(group_policy()),
          is_active: False,
          member_count,
        },
      ),
    ),
  )
  let group_burn = if burn_group_ref {
    assets.from_asset(group_policy(), group_ref_tn(), -1)
      |> assets.merge(assets.from_asset(group_policy(), group_user_tn(), -1))
  } else {
    assets.zero
  }
  let reserve_burn = if burn_reserve {
    assets.from_asset(treasury_policy(), reserve_tn(), -1)
  } else {
    assets.zero
  }
  Transaction {
    ..transaction.placeholder,
    inputs: [
      group_in,
      reserve_input(0, reserve_create_value() |> assets.merge(contribution(37))),
    ],
    outputs: [],
    mint: group_burn |> assets.merge(reserve_burn),
  }
}

fn run_close(tx: Transaction) -> Bool {
  validate_reserve_close(
    treasury_policy(),
    group_policy(),
    0,
    reserve_utxo_ref(),
    tx,
  )
}

test reserve_close__accepts_genuine_deletion() {
  run_close(close_tx(0, True, True))
}

test reserve_close__rejects_with_members_left() {
  !run_close(close_tx(1, True, True))
}

test reserve_close__rejects_without_group_burn() {
  !run_close(close_tx(0, False, True))
}

test reserve_close__rejects_without_reserve_burn() {
  !run_close(close_tx(0, True, False))
}

// ─── group_reserve_burned (deletion coupling) ─────────────────────────────────

test group_reserve_burned__accepts_burn() {
  let mint = assets.from_asset(treasury_policy(), reserve_tn(), -1)
  reserve.group_reserve_burned(treasury_policy(), group_ref_tn(), mint)
}

test group_reserve_burned__rejects_missing_burn() {
  let mint = assets.from_asset(group_policy(), group_ref_tn(), -1)
  !reserve.group_reserve_burned(treasury_policy(), group_ref_tn(), mint)
}

// ─── Refund equal-split property ──────────────────────────────────────────────

fn refund_group_input_m(member_count: Int) {
  common.test_input(
    transaction.OutputReference {
      transaction_id: #"6666666666666666666666666666666666666666666666666666666666666666",
      output_index: 0,
    },
    common.test_script_utxo(
      group_policy(),
      assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(group_policy(), group_ref_tn(), 1)),
      wrap_group(GroupDatum { ..refund_group_datum(2), member_count }),
    ),
  )
}

fn refund_group_output_m(member_count: Int) {
  common.test_script_utxo(
    group_policy(),
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(group_policy(), group_ref_tn(), 1)),
    wrap_group(GroupDatum { ..refund_group_datum(2), member_count }),
  )
}

fn refund_tx_m(member_count: Int, balance: Int, taken: Int) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      refund_group_input_m(member_count),
      refund_exiting_input(),
      reserve_input(
        0,
        reserve_create_value() |> assets.merge(contribution(balance)),
      ),
    ],
    outputs: [
      refund_group_output_m(member_count - 1),
      reserve_output(
        group_ref_tn(),
        0,
        reserve_create_value()
          |> assets.merge(contribution(balance - taken)),
      ),
    ],
  }
}

fn refund_bound_fuzzer() -> Fuzzer<(Int, Int)> {
  let member_count <- fuzz.and_then(fuzz.int_between(1, 20))
  let balance <- fuzz.and_then(fuzz.int_between(0, 100_000))
  fuzz.constant((member_count, balance))
}

// Taking exactly floor(balance / member_count) is always accepted.
test prop_reserve_refund__share_always_claimable(
  params via refund_bound_fuzzer(),
) {
  let (member_count, balance) = params
  run_refund(refund_tx_m(member_count, balance, balance / member_count))
}

// The last exiter (pre-exit member_count == 1) may drain the pot fully.
test reserve_refund__last_exiter_takes_all() {
  run_refund(refund_tx_m(1, 1000, 1000))
}

// ─── Review-gate additions (2026-07-03) ───────────────────────────────────────

// [AIK-4 / MLabs 11]: a creator-supplied stake credential on the communal pot
// would skim its staking rewards forever — enterprise address only at creation.
test create_reserve__rejects_foreign_stake_credential() {
  let staked = transaction.Output {
    address: address.Address {
      payment_credential: address.Script(treasury_policy()),
      stake_credential: Some(
        address.Inline(address.VerificationKey(common.test_pkh())),
      ),
    },
    value: reserve_create_value(),
    datum: transaction.InlineDatum(reserve_state(0)),
    reference_script: None,
  }
  let tx = Transaction {
    ..transaction.placeholder,
    outputs: [group_create_output(), staked],
    mint: create_mint(),
  }
  !validate_create_reserve(treasury_policy(), group_policy(), 0, 1, tx)
}

// Cover cannot cite a defaulter that belongs to a different group.
test reserve_cover__rejects_foreign_group_defaulter() {
  let foreign_defaulter = common.test_input(
    transaction.OutputReference {
      transaction_id: #"5555555555555555555555555555555555555555555555555555555555555555",
      output_index: 0,
    },
    common.test_script_utxo(
      treasury_policy(),
      assets.from_lovelace(2_000_000)
        |> assets.merge(
            assets.from_asset(treasury_policy(), cover_member_tn(), 1),
          )
        |> assets.merge(contribution(400)),
      DefaultState {
        group_reference_tokenname: #"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd",
        member_reference_tokenname: cover_member_tn(),
        grace_expires_at: 5000,
        grace_extensions_used: 0,
        rounds_paid: 1,
        member_payment_credential: common.test_pkh(),
        claimable_balance: 0,
      },
    ),
  )
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [
      cover_group_input(),
      foreign_defaulter,
      reserve_input(
        0,
        reserve_create_value() |> assets.merge(contribution(100)),
      ),
    ],
    outputs: [
      cover_group_output(0),
      reserve_output(
        group_ref_tn(),
        2,
        reserve_create_value() |> assets.merge(contribution(500)),
      ),
    ],
    mint: cover_burn(),
  }
  !run_cover(tx)
}

// The refund's exit citation cannot be the reserve itself (or any non-member
// datum) — only TreasuryState/DefaultState members of this group count.
test reserve_refund__rejects_reserve_as_exit_citation() {
  let balance = 1000
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [
      refund_group_input_m(2),
      reserve_input(
        0,
        reserve_create_value() |> assets.merge(contribution(balance)),
      ),
    ],
    outputs: [
      refund_group_output_m(1),
      reserve_output(
        group_ref_tn(),
        0,
        reserve_create_value() |> assets.merge(contribution(balance - 500)),
      ),
    ],
  }
  // exiting_treasury_input_index = 1 → the reserve input itself
  !validate_reserve_refund(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    1,
    1,
    reserve_utxo_ref(),
    tx,
  )
}

// ─── Reserve runner (treasury split — spec 2026-07-04 section 4/5) ────────────

fn runner_settings() -> settings.ProtocolSettings {
  settings.ProtocolSettings {
    account_policy: common.test_hash_03(),
    group_policy: group_policy(),
    treasury_policy: treasury_policy(),
    treasury_rounds_stake: common.test_hash_04(),
    treasury_lifecycle_stake: common.test_hash_05(),
    treasury_recovery_stake: common.test_hash_06(),
    treasury_reserve_stake: common.test_hash_07(),
  }
}

// Mirror of reserve_topup__accepts_growth through the runner — the action covers
// the reserve UTxO (input 0); the runner resolves its datum + outref from there.
test reserve_runner__accepts_topup_growth() {
  run_reserve_action(
    treasury_actions.TopUpAction {
      covered_inputs: [0],
      reserve_output_index: 0,
    },
    runner_settings(),
    topup_tx(group_ref_tn(), 0, topup_out_value(300)),
  )
}

// [security]: a TopUpAction must cover EXACTLY ONE reserve input.
test reserve_runner__rejects_topup_empty_coverage() fail {
  run_reserve_action(
    treasury_actions.TopUpAction { covered_inputs: [], reserve_output_index: 0 },
    runner_settings(),
    topup_tx(group_ref_tn(), 0, topup_out_value(300)),
  )
}

// [security]: the covered input must sit at the treasury script — a reserve
// action cannot validate against a foreign input (here: the group UTxO at the
// group script) as if it were the reserve.
test reserve_runner__rejects_topup_covering_foreign_input() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_ref_input()],
    outputs: [
      common.test_script_utxo(
        treasury_policy(),
        topup_out_value(300),
        reserve_state(0),
      ),
    ],
  }
  run_reserve_action(
    treasury_actions.TopUpAction {
      covered_inputs: [0],
      reserve_output_index: 0,
    },
    runner_settings(),
    tx,
  )
}

// [security]: a CreateAction covers no treasury input (one-shot with the group
// mint) — claiming coverage would exempt an unrelated treasury spend.
test reserve_runner__rejects_create_claiming_coverage() fail {
  let tx = create_reserve_tx(
    group_ref_tn(),
    0,
    reserve_create_value(),
    create_mint(),
  )
  run_reserve_action(
    treasury_actions.CreateAction {
      covered_inputs: [0],
      group_output_index: 0,
      reserve_output_index: 1,
    },
    runner_settings(),
    tx,
  )
}

test reserve_runner__rejects_cover_empty_coverage() fail {
  run_reserve_action(
    treasury_actions.CoverAction {
      covered_inputs: [],
      group_ref_input_index: 0,
      group_output_index: 0,
      defaulter_input_index: 0,
      reserve_output_index: 0,
    },
    runner_settings(),
    transaction.placeholder,
  )
}

test reserve_runner__rejects_refund_empty_coverage() fail {
  run_reserve_action(
    treasury_actions.RefundAction {
      covered_inputs: [],
      group_ref_input_index: 0,
      group_output_index: 0,
      exiting_treasury_input_index: 0,
      reserve_output_index: 0,
    },
    runner_settings(),
    transaction.placeholder,
  )
}

test reserve_runner__rejects_close_double_coverage() fail {
  run_reserve_action(
    treasury_actions.CloseAction {
      covered_inputs: [0, 1],
      group_input_index: 0,
    },
    runner_settings(),
    transaction.placeholder,
  )
}
