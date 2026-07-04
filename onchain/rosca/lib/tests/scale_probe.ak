use aiken/collection/list
use aiken/interval
use aiken/primitive/bytearray
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use dcu/group.{GroupCip68Datum, GroupDatum, Push}
use dcu/treasury.{TreasuryDatum, TreasuryState}
use dcu/treasury_utils.{min_ada_reserve}
use dcu/treasury_validation.{validate_distribute_withdraw}
use tests/common

// ─── Scale probe — distribute-round budget vs member count ───────────────────
//
// Constructs a COMPLETE, VALID distribute-withdraw transaction for N members and
// runs the real validation, so `aiken check` reports the genuine UPLC mem/cpu of
// the withdraw redeemer at each N. This is the measurement harness for finalizing
// `max_group_members`: read the per-test execution_units from
// `aiken check -m scale_probe` (JSON) and keep the cap at the largest N whose mem
// stays ≤ ~70% of the 14M per-tx limit (headroom for the per-input spend handlers,
// which the withdraw-zero pattern reduced to a thin withdrawal-presence check).
//
// N > 20 cases are synthetic (a real group cannot exceed max_group_members = 20);
// they exist to show how much room a raised cap would have.

const probe_fee: Int = 2_000_000

const probe_deposit: Int = 5_000_000

fn tp() -> assets.PolicyId {
  common.test_hash_01()
}

fn gp() -> assets.PolicyId {
  common.test_hash_02()
}

// 32-byte group reference token name (prefix100 + 28-byte suffix shape).
fn probe_group_ref() -> assets.AssetName {
  #"000643b0aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd"
}

fn borrower_pkh() -> ByteArray {
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}

// Distinct 28-byte member token name per index: 26-byte base + 2 index bytes.
fn probe_tn(i: Int) -> assets.AssetName {
  bytearray.push(
    bytearray.push(
      #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      i % 256,
    ),
    i / 256,
  )
}

fn probe_group_datum(n: Int) -> GroupDatum {
  GroupDatum {
    contribution_fee_policyid: #"",
    contribution_fee_assetname: #"",
    contribution_fee: probe_fee,
    joining_fee_policyid: #"",
    joining_fee_assetname: #"",
    joining_fee: 0,
    penalty_fee_policyid: #"",
    penalty_fee_assetname: #"",
    penalty_fee: 0,
    grace_period_length: 0,
    creator_bond: 0,
    interval_length: 1000,
    num_rounds: n,
    max_members: n,
    member_count: n,
    active_member_count: n,
    is_active: True,
    is_started: True,
    start_time: 0,
    last_distributed_round: -1,
    creator_payment_credential: VerificationKey(common.test_pkh()),
    member_token_names: list.map(list.range(0, n - 1), probe_tn),
    collateral_rounds: 1,
    payout_mode: Push,
    recovery_threshold: 1,
    recovery_timelock: 259_200_000,
    // Paired with member_token_names: probe_tn(i) holds slot i.
    member_slots: list.range(0, n - 1),
    era_start_round: 0,
    recommit_window: 259_200_000,
    reserve_join_levy: 0,
    reserve_round_levy: 0,
  }
}

fn probe_cip68(datum: GroupDatum) -> GroupCip68Datum {
  GroupCip68Datum {
    metadata: [Pair(#"6e616d65", "Scale Probe")],
    version: 1,
    extra: datum,
  }
}

fn probe_state(i: Int, rounds_paid: Int) -> TreasuryDatum {
  TreasuryState {
    group_reference_tokenname: probe_group_ref(),
    member_reference_tokenname: probe_tn(i),
    rounds_paid,
    member_payment_credential: borrower_pkh(),
    claimable_balance: 0,
  }
}

fn probe_treasury_input(i: Int) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"7777777777777777777777777777777777777777777777777777777777777777",
      output_index: i,
    },
    output: Output {
      address: Address {
        payment_credential: Script(tp()),
        stake_credential: None,
      },
      value: assets.from_lovelace(min_ada_reserve + probe_deposit)
        |> assets.merge(assets.from_asset(tp(), probe_tn(i), 1)),
      datum: InlineDatum(probe_state(i, 0)),
      reference_script: None,
    },
  }
}

fn probe_treasury_output(i: Int) -> Output {
  Output {
    address: Address {
      payment_credential: Script(tp()),
      stake_credential: None,
    },
    value: assets.from_lovelace(min_ada_reserve + probe_deposit - probe_fee)
      |> assets.merge(assets.from_asset(tp(), probe_tn(i), 1)),
    datum: InlineDatum(probe_state(i, 1)),
    reference_script: None,
  }
}

// Runs a full round-0 distribute for n members and validates it. Borrower is the
// member at slot 0 (Push mode — wallet output receives n × probe_fee).
fn run_probe(n: Int) -> Bool {
  let group_datum = probe_group_datum(n)
  let group_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp(), probe_group_ref(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"8888888888888888888888888888888888888888888888888888888888888888",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp()),
        stake_credential: None,
      },
      value: group_value,
      datum: InlineDatum(probe_cip68(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address {
      payment_credential: Script(gp()),
      stake_credential: None,
    },
    value: group_value,
    datum: InlineDatum(
      probe_cip68(GroupDatum { ..group_datum, last_distributed_round: 0 }),
    ),
    reference_script: None,
  }
  let borrower_output = Output {
    address: Address {
      payment_credential: VerificationKey(borrower_pkh()),
      stake_credential: None,
    },
    value: assets.from_lovelace(n * probe_fee),
    datum: transaction.NoDatum,
    reference_script: None,
  }

  let member_indices = list.range(0, n - 1)
  let treasury_inputs = list.map(member_indices, probe_treasury_input)
  let treasury_outputs = list.map(member_indices, probe_treasury_output)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, ..treasury_inputs],
    outputs: list.concat(treasury_outputs, [group_output, borrower_output]),
    validity_range: interval.after(0),
  }

  validate_distribute_withdraw(
    tp(),
    gp(),
    0,
    // group_ref_input_index (spending input 0)
    0,
    // group_output_index — after the n treasury outputs
    n,
    // treasury_input_indices: 1..n (group is input 0)
    list.map(member_indices, fn(i) { i + 1 }),
    // treasury_output_indices: 0..n-1
    member_indices,
    // borrower_output_index — after group output
    n + 1,
    tx,
  )
}

test scale_probe__distribute_n5() {
  run_probe(5)
}

test scale_probe__distribute_n10() {
  run_probe(10)
}

test scale_probe__distribute_n15() {
  run_probe(15)
}

test scale_probe__distribute_n20() {
  run_probe(20)
}

test scale_probe__distribute_n30() {
  run_probe(30)
}

// ─── Reserve-leg probe: levy ON + stand-in draw active (worst case) ───────────

const probe_levy: Int = 100_000

fn probe_reserve_tn() -> assets.AssetName {
  // prefix_rsv + the group ref's 28-byte unique part
  bytearray.concat(#"52535645", bytearray.drop(probe_group_ref(), 4))
}

// Runs the same full round-0 distribute with the reserve leg included: round
// levy accruing AND a stand-in fee-unit drawn (counter 2 → 1) — the heaviest
// shape the reserve adds to the hot path.
fn run_probe_reserve(n: Int) -> Bool {
  let group_datum = GroupDatum {
    ..probe_group_datum(n),
    reserve_round_levy: probe_levy,
  }
  let group_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp(), probe_group_ref(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"8888888888888888888888888888888888888888888888888888888888888888",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp()),
        stake_credential: None,
      },
      value: group_value,
      datum: InlineDatum(probe_cip68(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address {
      payment_credential: Script(gp()),
      stake_credential: None,
    },
    value: group_value,
    datum: InlineDatum(
      probe_cip68(GroupDatum { ..group_datum, last_distributed_round: 0 }),
    ),
    reference_script: None,
  }
  // Reserve: 5M contributable, stand-in counter 2 → draws one full fee (2M).
  let levy_total = n * probe_levy
  let draw = probe_fee
  let reserve_in = Input {
    output_reference: OutputReference {
      transaction_id: #"9999999999999999999999999999999999999999999999999999999999999999",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(tp()),
        stake_credential: None,
      },
      value: assets.from_lovelace(min_ada_reserve + 5_000_000)
        |> assets.merge(assets.from_asset(tp(), probe_reserve_tn(), 1)),
      datum: InlineDatum(
        treasury.ReserveState {
          group_reference_tokenname: probe_group_ref(),
          standin_rounds: 2,
        },
      ),
      reference_script: None,
    },
  }
  let reserve_out = Output {
    address: Address {
      payment_credential: Script(tp()),
      stake_credential: None,
    },
    value: assets.from_lovelace(min_ada_reserve + 5_000_000 + levy_total - draw)
      |> assets.merge(assets.from_asset(tp(), probe_reserve_tn(), 1)),
    datum: InlineDatum(
      treasury.ReserveState {
        group_reference_tokenname: probe_group_ref(),
        standin_rounds: 1,
      },
    ),
    reference_script: None,
  }
  let borrower_output = Output {
    address: Address {
      payment_credential: VerificationKey(borrower_pkh()),
      stake_credential: None,
    },
    value: assets.from_lovelace(n * probe_fee - levy_total + draw),
    datum: transaction.NoDatum,
    reference_script: None,
  }

  let member_indices = list.range(0, n - 1)
  let treasury_inputs = list.map(member_indices, probe_treasury_input)
  let treasury_outputs = list.map(member_indices, probe_treasury_output)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: list.concat([group_input, ..treasury_inputs], [reserve_in]),
    outputs: list.concat(
      treasury_outputs,
      [group_output, borrower_output, reserve_out],
    ),
    validity_range: interval.after(0),
  }

  validate_distribute_withdraw(
    tp(),
    gp(),
    0,
    0,
    // group_output_index — after the n treasury outputs
    n,
    // treasury inputs 1..n plus the reserve at n+1
    list.concat(list.map(member_indices, fn(i) { i + 1 }), [n + 1]),
    // treasury outputs 0..n-1 plus the reserve at n+2 (after group, borrower)
    list.concat(member_indices, [n + 2]),
    // borrower_output_index
    n + 1,
    tx,
  )
}

test scale_probe__distribute_reserve_n20() {
  run_probe_reserve(20)
}

test scale_probe__distribute_reserve_n30() {
  run_probe_reserve(30)
}
