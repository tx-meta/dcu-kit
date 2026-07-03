//// BeginRecommit (Cluster B): gate + effect tests.
//// Fixture: a started 3-member group. Registry is newest-first, so names
//// [c, b, a] pair with slots [2, 1, 0] — member a (first joiner) holds slot 0.

use aiken/interval
use cardano/assets
use cardano/transaction.{Transaction, placeholder}
use dcu/group.{GroupDatum, validate_begin_recommit}
use tests/common

const window_open_time = 5_000_000

fn started_group(policy_id) -> GroupDatum {
  GroupDatum {
    ..common.test_group_datum(policy_id),
    member_count: 3,
    active_member_count: 3,
    is_started: True,
    num_rounds: 3,
    start_time: 1_000,
    member_token_names: [#"cccc", #"bbbb", #"aaaa"],
    member_slots: [2, 1, 0],
    // Rounds 0..2 distributed: a full lap of era 0 — the boundary gate is open.
    last_distributed_round: 2,
  }
}

// Mid-cycle halt: member b (slot 1) exited after round 0; next round's slot is vacant.
fn halted_group(policy_id) -> GroupDatum {
  GroupDatum {
    ..started_group(policy_id),
    member_count: 2,
    active_member_count: 2,
    member_token_names: [#"cccc", #"aaaa"],
    member_slots: [2, 0],
    last_distributed_round: 0,
  }
}

fn expected_window(current: GroupDatum) -> GroupDatum {
  GroupDatum {
    ..current,
    is_started: False,
    start_time: window_open_time,
    member_slots: [],
  }
}

fn run_begin(
  current: GroupDatum,
  updated: GroupDatum,
  with_admin: Bool,
) -> Bool {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let group_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(policy_id, ref_tn, 1))
  let group_input = common.test_input(
    output_ref,
    common.test_script_utxo(policy_id, group_value, cip68(policy_id, current)),
  )
  let admin_token = if with_admin {
    assets.from_asset(policy_id, user_tn, 1)
  } else {
    assets.from_lovelace(2_000_000)
  }
  let admin_input = common.test_input(
    output_ref,
    common.test_user_utxo(common.test_pkh(), admin_token, cip68(policy_id, current)),
  )
  let group_output = common.test_script_utxo(
    policy_id,
    group_value,
    cip68(policy_id, updated),
  )
  let tx = Transaction {
    ..placeholder,
    inputs: [group_input, admin_input],
    outputs: [group_output],
    validity_range: interval.after(window_open_time),
  }
  validate_begin_recommit(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
    tx,
  )
}

fn cip68(_policy_id, datum: GroupDatum) {
  let wrapped =
    group.GroupCip68Datum {
      metadata: [Pair(#"6e616d65", "Test Group")],
      version: 1,
      extra: datum,
    }
  let as_data: Data = wrapped
  as_data
}

test begin_recommit__accepts_at_clean_boundary() {
  let policy_id = common.test_policy_id()
  let current = started_group(policy_id)
  run_begin(current, expected_window(current), True)
}

// [spec D10]: the halt case — next round's slot is provably vacant, all remaining
// members clean. This gate opening is the reason Recommit exists.
test begin_recommit__accepts_at_vacant_slot_halt() {
  let policy_id = common.test_policy_id()
  let current = halted_group(policy_id)
  run_begin(current, expected_window(current), True)
}

// Mid-cycle, no vacancy: rounds 0 done, next slot 1 is held by b — rotation can
// proceed, so there is nothing to reset.
test begin_recommit__rejects_mid_cycle_without_vacancy() {
  let policy_id = common.test_policy_id()
  let current =
    GroupDatum { ..started_group(policy_id), last_distributed_round: 0 }
  !run_begin(current, expected_window(current), True)
}

// A defaulter exists (active < member): reset would be an escape hatch — rejected.
test begin_recommit__rejects_with_defaulter() {
  let policy_id = common.test_policy_id()
  let current =
    GroupDatum { ..started_group(policy_id), active_member_count: 2 }
  !run_begin(current, expected_window(current), True)
}

test begin_recommit__rejects_without_admin_token() {
  let policy_id = common.test_policy_id()
  let current = started_group(policy_id)
  !run_begin(current, expected_window(current), False)
}

test begin_recommit__rejects_not_started() {
  let policy_id = common.test_policy_id()
  let current =
    GroupDatum { ..started_group(policy_id), is_started: False, member_slots: [] }
  !run_begin(
    current,
    GroupDatum { ..current, start_time: window_open_time },
    True,
  )
}

test begin_recommit__rejects_inactive_group() {
  let policy_id = common.test_policy_id()
  let current = GroupDatum { ..started_group(policy_id), is_active: False }
  !run_begin(current, expected_window(current), True)
}

// Effect tampering: the window must not touch any counter or the registry.
test begin_recommit__rejects_registry_tamper() {
  let policy_id = common.test_policy_id()
  let current = started_group(policy_id)
  let tampered =
    GroupDatum {
      ..expected_window(current),
      member_token_names: [#"cccc", #"bbbb"],
      member_count: 2,
      active_member_count: 2,
    }
  !run_begin(current, tampered, True)
}

test begin_recommit__rejects_era_tamper() {
  let policy_id = common.test_policy_id()
  let current = started_group(policy_id)
  !run_begin(
    current,
    GroupDatum { ..expected_window(current), era_start_round: 99 },
    True,
  )
}

test begin_recommit__rejects_round_counter_tamper() {
  let policy_id = common.test_policy_id()
  let current = started_group(policy_id)
  !run_begin(
    current,
    GroupDatum { ..expected_window(current), last_distributed_round: -1 },
    True,
  )
}

test begin_recommit__rejects_slots_kept() {
  let policy_id = common.test_policy_id()
  let current = started_group(policy_id)
  !run_begin(
    current,
    GroupDatum { ..expected_window(current), member_slots: [2, 1, 0] },
    True,
  )
}
