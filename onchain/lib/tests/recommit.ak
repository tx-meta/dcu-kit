//// BeginRecommit (Cluster B): gate + effect tests.
//// Fixture: a started 3-member group. Registry is newest-first, so names
//// [c, b, a] pair with slots [2, 1, 0] — member a (first joiner) holds slot 0.

use aiken/collection/list
use aiken/fuzz
use aiken/interval
use aiken/primitive/bytearray
use aiken/primitive/int
use cardano/assets
use cardano/transaction.{Transaction, placeholder}
use dcu/group.{GroupDatum, validate_begin_recommit}
use dcu/treasury_validation
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

// ─── StartGroup as the (re-)sealer ───────────────────────────────────────────

fn run_start(
  current: GroupDatum,
  updated: GroupDatum,
  lower_bound: Int,
) -> Bool {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let group_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(policy_id, ref_tn, 1))
  let group_input = common.test_input(
    output_ref,
    common.test_script_utxo(policy_id, group_value, cip68(policy_id, current)),
  )
  let admin_input = common.test_input(
    output_ref,
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      cip68(policy_id, current),
    ),
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
    validity_range: interval.after(lower_bound),
  }
  group.validate_start_group(
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

fn sealed(current: GroupDatum, at: Int, era: Int, n: Int) -> GroupDatum {
  GroupDatum {
    ..current,
    is_started: True,
    num_rounds: n,
    start_time: at,
    active_member_count: n,
    member_slots: countdown(n),
    era_start_round: era,
  }
}

// Registry is newest-first, so slots count down: [n-1, .., 0].
fn countdown(n: Int) -> List<Int> {
  when n is {
    2 -> [1, 0]
    3 -> [2, 1, 0]
    _ -> fail @"unsupported fixture size"
  }
}

test start_group__fresh_seal_assigns_slots_and_era_zero() {
  let policy_id = common.test_policy_id()
  let current =
    GroupDatum {
      ..common.test_group_datum(policy_id),
      member_count: 2,
      member_token_names: [#"bbbb", #"aaaa"],
    }
  run_start(current, sealed(current, 9_000, 0, 2), 9_000)
}

// The spec §1 collision scenario: A and B join, A exits pre-start, C joins.
// Registry (newest-first): [c, b]. Seal assigns [1, 0] — b (earliest remaining)
// borrows first, no collision, no vacant slot. The bug is structurally gone.
test start_group__pre_start_exit_rejoin_starts_cleanly() {
  let policy_id = common.test_policy_id()
  let current =
    GroupDatum {
      ..common.test_group_datum(policy_id),
      member_count: 2,
      member_token_names: [#"cccc", #"bbbb"],
    }
  run_start(current, sealed(current, 9_000, 0, 2), 9_000)
}

// Recommit-window state: rounds have run (last_distributed_round = 2), one member
// exited during the window, start_time carries the window-open time.
fn window_group(policy_id) -> GroupDatum {
  GroupDatum {
    ..common.test_group_datum(policy_id),
    member_count: 2,
    active_member_count: 3,
    is_started: False,
    num_rounds: 3,
    start_time: window_open_time,
    last_distributed_round: 2,
    era_start_round: 0,
    member_token_names: [#"cccc", #"aaaa"],
    member_slots: [],
  }
}

test start_group__reseal_after_window_starts_new_era() {
  let policy_id = common.test_policy_id()
  let current = window_group(policy_id)
  let seal_time = window_open_time + current.recommit_window + 1
  run_start(current, sealed(current, seal_time, 3, 2), seal_time)
}

test start_group__reseal_before_window_rejected() {
  let policy_id = common.test_policy_id()
  let current = window_group(policy_id)
  let too_early = window_open_time + current.recommit_window - 1
  !run_start(current, sealed(current, too_early, 3, 2), too_early)
}

test start_group__reseal_era_tamper_rejected() {
  let policy_id = common.test_policy_id()
  let current = window_group(policy_id)
  let seal_time = window_open_time + current.recommit_window + 1
  let tampered = GroupDatum { ..sealed(current, seal_time, 3, 2), era_start_round: 0 }
  !run_start(current, tampered, seal_time)
}

test start_group__reseal_slot_order_tamper_rejected() {
  let policy_id = common.test_policy_id()
  let current = window_group(policy_id)
  let seal_time = window_open_time + current.recommit_window + 1
  let tampered = GroupDatum { ..sealed(current, seal_time, 3, 2), member_slots: [0, 1] }
  !run_start(current, tampered, seal_time)
}

test start_group__reseal_num_rounds_tamper_rejected() {
  let policy_id = common.test_policy_id()
  let current = window_group(policy_id)
  let seal_time = window_open_time + current.recommit_window + 1
  let tampered = GroupDatum { ..sealed(current, seal_time, 3, 2), num_rounds: 3 }
  !run_start(current, tampered, seal_time)
}

// ─── Properties: era arithmetic + registry pairing ───────────────────────────

fn gen_era_case() -> Fuzzer<(Int, Int, Int)> {
  let era_start <- fuzz.and_then(fuzz.int_between(0, 1_000_000))
  let n <- fuzz.and_then(fuzz.int_between(2, 20))
  let k <- fuzz.and_then(fuzz.int_between(0, 3 * n))
  fuzz.constant((era_start, n, k))
}

// Within any era, the borrower sequence over consecutive rounds is the joiners in
// FCFS order, wrapping every n rounds — resolved through the REAL registry lookup
// (newest-first names paired with countdown slots).
test prop_era__borrower_sequence_is_fcfs_wrap(case via gen_era_case()) {
  let (era_start, n, k) = case
  // Registry: newest-first; joiner j (0-based join order) has name #[j] and sits at
  // index n-1-j with slot j.
  let names = list.map(list.reverse(list.range(0, n - 1)), fn(j) { as_name(j) })
  let slots = list.reverse(list.range(0, n - 1))
  let round = era_start + k
  let effective = ( round - era_start ) % n
  treasury_validation.find_name_for_slot(names, slots, effective) == Some(
    as_name(k % n),
  )
}

fn as_name(j: Int) -> ByteArray {
  bytearray.push(#"", j)
}

fn gen_removal_case() -> Fuzzer<(Int, Int)> {
  let n <- fuzz.and_then(fuzz.int_between(2, 20))
  let target <- fuzz.and_then(fuzz.int_between(0, n - 1))
  fuzz.constant((n, target))
}

// remove_paired drops exactly the target's entry from BOTH lists and preserves
// every other pairing (no re-pack, no reordering).
test prop_registry__paired_removal_preserves_pairing(
  case via gen_removal_case(),
) {
  let (n, target) = case
  let names = list.map(list.range(0, n - 1), as_name)
  let slots = list.reverse(list.range(0, n - 1))
  let (rest_names, rest_slots) = group.remove_paired(names, slots, as_name(target))
  let expected_pairs =
    list.filter(
      list.zip(names, slots),
      fn(p) {
        let (nm, _) = p
        nm != as_name(target)
      },
    )
  list.zip(rest_names, rest_slots) == expected_pairs
}

// The sealed slot map is always a permutation of 0..n-1 (countdown by construction).
test prop_seal__slot_map_is_permutation(n via fuzz.int_between(2, 20)) {
  let slots = list.reverse(list.range(0, n - 1))
  let sorted = list.sort(slots, fn(a, b) { int.compare(a, b) })
  list.length(slots) == n && sorted == list.range(0, n - 1)
}

fn gen_rounds_case() -> Fuzzer<Int> {
  fuzz.int_between(0, 8)
}

// Full roster (no vacancy): the gate opens exactly at era boundaries.
test prop_begin__boundary_only_when_full(k via gen_rounds_case()) {
  let policy_id = common.test_policy_id()
  let current =
    GroupDatum { ..started_group(policy_id), last_distributed_round: k }
  run_begin(current, expected_window(current), True) == ( ( k + 1 ) % 3 == 0 )
}

// Slot-1 holder exited: the gate ALSO opens whenever the next round lands on the
// vacancy (D10), on top of the boundary case.
test prop_begin__vacancy_or_boundary_when_halted(k via gen_rounds_case()) {
  let policy_id = common.test_policy_id()
  let current =
    GroupDatum { ..halted_group(policy_id), last_distributed_round: k }
  let next = ( k + 1 ) % 3
  run_begin(current, expected_window(current), True) == ( next == 0 || next == 1 )
}
