use aiken/collection/list
use aiken/interval
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use dcu/cip68
use dcu/group.{GroupDatum}
use dcu/treasury.{
  Contribution, PenaltyState, TreasuryDatum, TreasuryState, claimable_sum,
  remove_claimable, validate_distribute_payout, validate_exit_group,
  validate_join_group, validate_member_withdraw, validate_spend_terminate_group,
  validate_terminate_group,
}
use tests/common

// ─── Shared test helpers ──────────────────────────────────────────────────────

// Three distinct policy IDs for treasury, group, and account
fn treasury_policy() -> assets.PolicyId {
  common.test_hash_01()
}

fn group_policy() -> assets.PolicyId {
  common.test_hash_02()
}

fn account_policy() -> assets.PolicyId {
  common.test_hash_03()
}

// Fixed 28-byte membership token name (account user token name)
fn member_tn() -> assets.AssetName {
  #"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd"
}

// Fixed group reference token name
fn group_ref_tn() -> assets.AssetName {
  #"001100110011001100110011001100110011001100110011001100"
}

// Group UTxO at Script(group_policy) holding the ref token
fn test_group_input() -> Input {
  let gp = group_policy()
  let value =
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value,
      datum: InlineDatum(test_group_datum()),
      reference_script: None,
    }
  Input {
    output_reference: OutputReference {
      transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
      output_index: 0,
    },
    output,
  }
}

// Group datum with ADA fees (so treasury output policy guard passes).
// joining_fee = 0 by default so existing tests don't need an admin payment output.
// Override with a non-zero joining_fee to test joining_fee_routed logic.
fn test_group_datum() -> GroupDatum {
  GroupDatum {
    // fees in ADA — policy guard: policies(treasury_output) == [ada, treasury_policy]
    contribution_fee_policyid: assets.ada_policy_id,
    contribution_fee_assetname: #"",
    contribution_fee: 2_000_000,
    joining_fee_policyid: assets.ada_policy_id,
    joining_fee_assetname: #"",
    joining_fee: 0,
    penalty_fee_policyid: assets.ada_policy_id,
    penalty_fee_assetname: #"",
    penalty_fee: 500_000,
    interval_length: 1000,
    num_intervals: 3,
    max_members: 30,
    member_count: 0,
    is_active: True,
    start_time: 0,
    admin_payment_credential: common.test_pkh(),
  }
}

// 3-interval contribution list aligned with test_group_datum
fn test_contribution_list() -> List<Contribution> {
  [
    Contribution { claimable_at: 1000, claimable_amount: 2_000_000 },
    Contribution { claimable_at: 2000, claimable_amount: 2_000_000 },
    Contribution { claimable_at: 3000, claimable_amount: 2_000_000 },
  ]
}

// Core builder — single definition point for TreasuryState test datums.
// All inline TreasuryState constructions in this file use this function.
fn build_treasury_state(
  assigned_slot: Int,
  group_ref_token: assets.AssetName,
  contributions: List<Contribution>,
) -> TreasuryDatum {
  TreasuryState {
    group_reference_tokenname: group_ref_token,
    member_reference_tokenname: member_tn(),
    membership_start: 0,
    assigned_slot,
    contribution_list: contributions,
    member_payment_credential: common.test_pkh(),
  }
}

// Convenience wrapper: standard group token + standard contribution list
fn test_treasury_state(assigned_slot: Int) -> TreasuryDatum {
  build_treasury_state(assigned_slot, group_ref_tn(), test_contribution_list())
}

// Treasury UTxO value: min ADA + 1 membership token
fn treasury_value() -> assets.Value {
  assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(treasury_policy(), member_tn(), 1))
}

// Treasury output at treasury script address
fn test_treasury_output(datum: TreasuryDatum, value: assets.Value) -> Output {
  Output {
    address: Address {
      payment_credential: Script(treasury_policy()),
      stake_credential: None,
    },
    value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

// Treasury input wrapping an output
fn test_treasury_input(output_ref: OutputReference, output: Output) -> Input {
  Input { output_reference: output_ref, output }
}

// Member input at a wallet holding the account user token
fn test_member_input() -> Input {
  let ap = account_policy()
  let value = assets.from_asset(ap, member_tn(), 1)
  let output =
    Output {
      address: Address {
        payment_credential: VerificationKey(common.test_pkh()),
        stake_credential: None,
      },
      value,
      datum: NoDatum,
      reference_script: None,
    }
  Input {
    output_reference: OutputReference {
      transaction_id: #"2222222222222222222222222222222222222222222222222222222222222222",
      output_index: 0,
    },
    output,
  }
}

// Group output at Script(group_policy) with the given member_count.
// Used in JoinGroup tests (member_count + 1) and ExitGroup tests (unchanged or - 1).
fn test_group_output(member_count: Int) -> Output {
  let gp = group_policy()
  let datum = GroupDatum { ..test_group_datum(), member_count }
  Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

// Standard treasury UTxO output reference
fn treasury_utxo_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    output_index: 0,
  }
}

// Borrower output at a wallet address
fn test_borrower_output() -> Output {
  Output {
    address: Address {
      payment_credential: VerificationKey(common.test_pkh()),
      stake_credential: None,
    },
    value: assets.from_lovelace(4_000_000),
    datum: NoDatum,
    reference_script: None,
  }
}

// Group admin (222) token name — derived from group_ref_tn() via CIP-68 conversion,
// mirroring the same derivation in validate_spend_terminate_group.
fn group_admin_tn() -> assets.AssetName {
  cip68.convert_ref_to_user_token(group_ref_tn())
}

// Admin input holding the group user (222) token under group_policy.
fn test_admin_input() -> Input {
  let gp = group_policy()
  Input {
    output_reference: OutputReference {
      transaction_id: #"4444444444444444444444444444444444444444444444444444444444444444",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: VerificationKey(common.test_pkh()),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_admin_tn(), 1)),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// ─── claimable_sum ────────────────────────────────────────────────────────────

test claimable_sum__returns_zero_when_none_due() {
  claimable_sum(test_contribution_list(), 500) == 0
}

test claimable_sum__returns_one_entry_when_one_due() {
  claimable_sum(test_contribution_list(), 1000) == 2_000_000
}

test claimable_sum__returns_all_when_all_due() {
  claimable_sum(test_contribution_list(), 5000) == 6_000_000
}

// ─── remove_claimable ─────────────────────────────────────────────────────────

test remove_claimable__keeps_all_when_none_due() {
  remove_claimable(test_contribution_list(), 500) == test_contribution_list()
}

test remove_claimable__removes_past_entries() {
  let remaining = remove_claimable(test_contribution_list(), 2000)
  remaining == [
    Contribution { claimable_at: 3000, claimable_amount: 2_000_000 },
  ]
}

test remove_claimable__removes_all() {
  remove_claimable(test_contribution_list(), 5000) == []
}

// ─── validate_terminate_group (mint: burn path) ───────────────────────────────

test terminate_group__accepts_valid_burn() {
  let mint = assets.from_asset(treasury_policy(), member_tn(), -1)
  validate_terminate_group(treasury_policy(), mint)
}

/// validate_terminate_group returns False (not crash) when qty != -1 — use !
test terminate_group__rejects_positive_qty() {
  let mint = assets.from_asset(treasury_policy(), member_tn(), 1)
  !validate_terminate_group(treasury_policy(), mint)
}

// fail annotation: expect crashes when two tokens in the dict
test terminate_group__rejects_two_tokens_burned() fail {
  let other_tn = #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  let mint =
    assets.from_asset(treasury_policy(), member_tn(), -1)
      |> assets.merge(assets.from_asset(treasury_policy(), other_tn, -1))
  validate_terminate_group(treasury_policy(), mint)
}

// ─── validate_join_group ──────────────────────────────────────────────────────

test join_group__accepts_valid_join() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  // Value: enough ADA for contribution_fee (2M) + treasury token; joining_fee = 0 so no admin output needed
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  // Group output: member_count 0 → 1
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  // group_ref_input_index=0, group_output_index=1, member_input_index=1, treasury_output_index=0
  validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_wrong_member_count_slot() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  // assigned_slot = 1 but group.member_count = 0
  let datum = test_treasury_state(1)
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_wrong_contribution_list() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  // Contribution list with wrong amounts
  let bad_list =
    [
      Contribution { claimable_at: 1000, claimable_amount: 999 },
      Contribution { claimable_at: 2000, claimable_amount: 2_000_000 },
      Contribution { claimable_at: 3000, claimable_amount: 2_000_000 },
    ]
  let datum = build_treasury_state(0, group_ref_tn(), bad_list)
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_extra_token_minted() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let other_tn = #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  let mint =
    assets.from_asset(tp, member_tn(), 1)
      |> assets.merge(assets.from_asset(tp, other_tn, 1))

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_insufficient_fees() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  // Only 1 ADA — not enough for 2M contribution_fee required
  let output_value =
    assets.from_lovelace(1_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

// joining_fee > 0 but no output at admin_payment_credential — joining_fee_routed fails
test join_group__rejects_joining_fee_not_routed_to_admin() {
  let tp = treasury_policy()

  // Override joining_fee to 1M — requires an admin payment output
  let group_datum_with_fee = GroupDatum { ..test_group_datum(), joining_fee: 1_000_000 }
  let gp = group_policy()
  let group_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
        output_index: 0,
      },
      output: Output {
        address: Address {
          payment_credential: Script(gp),
          stake_credential: None,
        },
        value: assets.from_lovelace(2_000_000)
          |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
        datum: InlineDatum(group_datum_with_fee),
        reference_script: None,
      },
    }
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  // 2M ADA — satisfies contribution_fee but no admin output for joining_fee
  let output_value =
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  // Group output: member_count 0 → 1
  let group_out =
    Output {
      address: Address { payment_credential: Script(gp), stake_credential: None },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(GroupDatum { ..group_datum_with_fee, member_count: 1 }),
      reference_script: None,
    }
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      // No admin payment output — joining_fee_routed must fail
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

// joining_fee > 0 and admin output at admin_payment_credential — should pass
test join_group__accepts_joining_fee_routed_to_admin() {
  let tp = treasury_policy()

  // Override joining_fee to 1M
  let group_datum_with_fee = GroupDatum { ..test_group_datum(), joining_fee: 1_000_000 }
  let gp = group_policy()
  let group_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
        output_index: 0,
      },
      output: Output {
        address: Address {
          payment_credential: Script(gp),
          stake_credential: None,
        },
        value: assets.from_lovelace(2_000_000)
          |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
        datum: InlineDatum(group_datum_with_fee),
        reference_script: None,
      },
    }
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  // 2M ADA — satisfies contribution_fee
  let output_value =
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  // Group output: member_count 0 → 1
  let group_out =
    Output {
      address: Address { payment_credential: Script(gp), stake_credential: None },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(GroupDatum { ..group_datum_with_fee, member_count: 1 }),
      reference_script: None,
    }
  // Admin payment output at admin_payment_credential (test_pkh) with >= joining_fee (1M)
  let admin_output =
    Output {
      address: Address {
        payment_credential: VerificationKey(common.test_pkh()),
        stake_credential: None,
      },
      value: assets.from_lovelace(1_000_000),
      datum: NoDatum,
      reference_script: None,
    }
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, group_out, admin_output],
      mint,
      validity_range: interval.after(0),
    }

  // group_ref_input_index=0, group_output_index=1, member_input_index=1, treasury_output_index=0
  validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

// Group is deactivated — group_active check fails
test join_group__rejects_inactive_group() {
  let tp = treasury_policy()
  let gp = group_policy()

  // Override is_active to False
  let inactive_datum = GroupDatum { ..test_group_datum(), is_active: False }
  let inactive_group_output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(inactive_datum),
      reference_script: None,
    }
  let inactive_group_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
        output_index: 0,
      },
      output: inactive_group_output,
    }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [inactive_group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

// Group is at max capacity (member_count == max_members) — join must be rejected
test join_group__rejects_group_at_capacity() {
  let tp = treasury_policy()
  let gp = group_policy()

  // Set member_count == max_members (group is full)
  let full_datum =
    GroupDatum { ..test_group_datum(), max_members: 3, member_count: 3 }
  let full_group_output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(full_datum),
      reference_script: None,
    }
  let full_group_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
        output_index: 0,
      },
      output: full_group_output,
    }

  let member_input = test_member_input()
  let datum = test_treasury_state(3)
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  // Group output must show incremented count for the redeemer's group_output_index to resolve
  let group_out =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(GroupDatum { ..full_datum, member_count: 4 }),
      reference_script: None,
    }
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [full_group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

// membership_start in datum (999) doesn't match tx lower bound (0) — constraint fails
test join_group__rejects_wrong_membership_start() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  // membership_start set to 999 but tx lower bound is 0
  let bad_datum =
    TreasuryState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
      membership_start: 999,
      assigned_slot: 0,
      contribution_list: test_contribution_list(),
      member_payment_credential: common.test_pkh(),
    }
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(bad_datum, output_value)
  let group_out = test_group_output(1)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_token_stuffing_in_output() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  let other_tn = #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  // Two tokens under the treasury policy — violates exact token check
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
      |> assets.merge(assets.from_asset(tp, other_tn, 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_output_at_wallet() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  // Treasury output sent to wallet instead of script
  let bad_output =
    Output {
      address: Address {
        payment_credential: VerificationKey(common.test_pkh()),
        stake_credential: None,
      },
      value: output_value,
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [bad_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_member_input_without_account_nft() {
  let tp = treasury_policy()

  let group_input = test_group_input()

  // Member input holds only ADA — no account user token
  let wallet_only_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"2222222222222222222222222222222222222222222222222222222222222222",
        output_index: 0,
      },
      output: Output {
        address: Address {
          payment_credential: VerificationKey(common.test_pkh()),
          stake_credential: None,
        },
        value: assets.from_lovelace(2_000_000),
        datum: NoDatum,
        reference_script: None,
      },
    }

  let datum = test_treasury_state(0)
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, wallet_only_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_wrong_group_link() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  // datum group_reference_tokenname doesn't match the actual group token
  let wrong_group_tn = #"ffff00ffff00ffff00ffff00ffff00ffff00ffff00ffff00ffff00"
  let datum = build_treasury_state(0, wrong_group_tn, test_contribution_list())
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

// ─── member_count / cross-validator state transition tests ────────────────────
//
// These tests verify that slot assignment is sequential across members and that
// the group output datum is updated atomically with each join. The validator
// reads group.member_count for slot assignment and checks that the group output
// at group_output_index has member_count + 1, enforcing the state transition.

// Helper: builds a group Input with an overridden member_count.
fn test_group_input_with_member_count(member_count: Int) -> Input {
  let gp = group_policy()
  let datum = GroupDatum { ..test_group_datum(), member_count }
  let value =
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value,
      datum: InlineDatum(datum),
      reference_script: None,
    }
  Input {
    output_reference: OutputReference {
      transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
      output_index: 0,
    },
    output,
  }
}

// Sequential slot assignment: the second member's assigned_slot must equal
// group.member_count (1) at the time they join.
test join_group__second_member_gets_sequential_slot() {
  let tp = treasury_policy()

  // group.member_count = 1 — first member has already joined
  let group_input = test_group_input_with_member_count(1)
  let member_input = test_member_input()

  // Second member claims slot 1 (== member_count) — correct
  let datum = test_treasury_state(1)
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  // Group output: member_count 1 → 2
  let group_out = test_group_output(2)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

// Slot collision guard: a second joiner must NOT be able to claim slot 0
// (already assigned to the first member) when group.member_count is 1.
test join_group__rejects_slot_collision_with_existing_member() {
  let tp = treasury_policy()

  // group.member_count = 1 — slot 0 is already taken
  let group_input = test_group_input_with_member_count(1)
  let member_input = test_member_input()

  // Attempted: assigned_slot = 0 — collides with existing member
  let datum = test_treasury_state(0)
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  // Group output: member_count 1 → 2 (correct increment, but slot is wrong — slot_valid fails)
  let group_out = test_group_output(2)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, group_out],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

// Group output with non-incremented member_count must be rejected.
// The validator verifies updated_group.member_count == group.member_count + 1 atomically
// via the group_output_index parameter — so passing an unchanged member_count fails.
test join_group__rejects_group_output_without_member_count_increment() {
  let tp = treasury_policy()

  // Group input: member_count = 0
  let group_input = test_group_input()

  // Group output: member_count still 0 — not incremented → must be rejected
  let unchanged_group_output =
    Output {
      address: group_input.output.address,
      value: group_input.output.value,
      datum: InlineDatum(test_group_datum()),
      reference_script: None,
    }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)
  let output_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [treasury_output, unchanged_group_output],
      mint,
      validity_range: interval.after(0),
    }

  !validate_join_group(tp, account_policy(), 0, 1, 1, 0, tx)
}

// ─── validate_distribute_payout ───────────────────────────────────────────────

// Setup for DistributePayout: current_time = 2500
// current_slot = 2500 / 1000 % 3 = 2 → borrower is assigned_slot 2
// Claimable entries: [1000, 2000] are past → remaining = [3000]
fn setup_distribute_payout() -> (Transaction, TreasuryDatum, OutputReference) {
  let tp = treasury_policy()
  let gp = group_policy()

  let current_time = 2500

  // Group as reference input
  let group_ref_output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(test_group_datum()),
      reference_script: None,
    }
  let group_ref_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
        output_index: 0,
      },
      output: group_ref_output,
    }

  // Treasury input: assigned_slot = 2 (the borrower)
  let treasury_datum = test_treasury_state(2)
  let treasury_in_value = treasury_value()
  let treasury_in_output =
    test_treasury_output(treasury_datum, treasury_in_value)
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(utxo_ref, treasury_in_output)

  // Treasury output: datum updated — claimable entries at 1000, 2000 removed
  let remaining =
    [Contribution { claimable_at: 3000, claimable_amount: 2_000_000 }]
  let updated_datum = build_treasury_state(2, group_ref_tn(), remaining)
  // ADA reduced by claimable paid out: 5M - 4M = 1M + min for token
  let treasury_out_value =
    assets.from_lovelace(1_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_out = test_treasury_output(updated_datum, treasury_out_value)

  let borrower_out = test_borrower_output()

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [treasury_in],
      reference_inputs: [group_ref_input],
      outputs: [treasury_out, borrower_out],
      validity_range: interval.after(current_time),
    }

  (tx, treasury_datum, utxo_ref)
}

test distribute_payout__accepts_valid_payout() {
  let (tx, datum, utxo) = setup_distribute_payout()
  validate_distribute_payout(
    treasury_policy(),
    // group_ref_input_index in reference_inputs
    0,
    // treasury_input_indices, treasury_output_indices
    [0],
    [0],
    // borrower_output_index
    1,
    datum,
    utxo,
    tx,
  )
}

// fail: expect TreasuryState crashes when datum is PenaltyState
test distribute_payout__rejects_penalty_state_datum() fail {
  let (tx, _, utxo) = setup_distribute_payout()
  let penalty_datum =
    PenaltyState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
    }
  validate_distribute_payout(
    treasury_policy(),
    0,
    [0],
    [0],
    1,
    penalty_datum,
    utxo,
    tx,
  )
}

// Treasury output retains full input ADA despite entries being marked paid
// → ada_balance_correct check fails
test distribute_payout__rejects_no_ada_reduction() {
  let tp = treasury_policy()
  let (tx, datum, utxo) = setup_distribute_payout()

  // Rebuild the tx with treasury output keeping all 5M ADA (no reduction)
  let Transaction { inputs, reference_inputs, outputs, validity_range, .. } = tx
  // outputs[0] is the treasury out — replace with one that keeps full ADA
  expect Some(old_treasury_out) = list.at(outputs, 0)
  let no_reduction_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let bad_treasury_out =
    Output { ..old_treasury_out, value: no_reduction_value }
  let new_outputs = list.concat([bad_treasury_out], list.drop(outputs, 1))

  let bad_tx =
    Transaction {
      ..transaction.placeholder,
      inputs,
      reference_inputs,
      outputs: new_outputs,
      validity_range,
    }

  !validate_distribute_payout(tp, 0, [0], [0], 1, datum, utxo, bad_tx)
}

// Treasury output has wrong (non-updated) datum — claimable entries not removed
// → datum_updated_correctly check fails
test distribute_payout__rejects_wrong_datum_update() {
  let tp = treasury_policy()
  let (tx, datum, utxo) = setup_distribute_payout()

  let Transaction { inputs, reference_inputs, outputs, validity_range, .. } = tx
  // Replace treasury output datum with original (not pruned) contribution list
  expect Some(old_treasury_out) = list.at(outputs, 0)
  let stale_datum = test_treasury_state(2)
  let bad_treasury_out =
    Output { ..old_treasury_out, datum: InlineDatum(stale_datum) }
  let new_outputs = list.concat([bad_treasury_out], list.drop(outputs, 1))

  let bad_tx =
    Transaction {
      ..transaction.placeholder,
      inputs,
      reference_inputs,
      outputs: new_outputs,
      validity_range,
    }

  !validate_distribute_payout(tp, 0, [0], [0], 1, datum, utxo, bad_tx)
}

// Borrower output is at a script address instead of a wallet
// → borrower_at_wallet check fails
test distribute_payout__rejects_borrower_output_at_script() {
  let tp = treasury_policy()
  let (tx, datum, utxo) = setup_distribute_payout()

  let Transaction { inputs, reference_inputs, outputs, validity_range, .. } = tx
  // Keep treasury output (index 0), replace borrower output (index 1) with script address
  expect Some(treasury_out) = list.at(outputs, 0)
  expect Some(old_borrower_out) = list.at(outputs, 1)
  let script_borrower =
    Output {
      ..old_borrower_out,
      address: Address {
        payment_credential: Script(tp),
        stake_credential: None,
      },
    }

  let bad_tx =
    Transaction {
      ..transaction.placeholder,
      inputs,
      reference_inputs,
      outputs: [treasury_out, script_borrower],
      validity_range,
    }

  !validate_distribute_payout(tp, 0, [0], [0], 1, datum, utxo, bad_tx)
}

// current_slot = 2, but the only treasury input has assigned_slot = 1
// → expect Some(borrower_cred) = list.find_map(...) crashes (no matching slot found)
test distribute_payout__rejects_when_borrower_absent() fail {
  let tp = treasury_policy()
  let gp = group_policy()

  let current_time = 2500

  let group_ref_output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(test_group_datum()),
      reference_script: None,
    }
  let group_ref_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
        output_index: 0,
      },
      output: group_ref_output,
    }

  // assigned_slot = 1 — NOT the borrower for slot 2
  let wrong_slot_datum = test_treasury_state(1)
  let treasury_in_output =
    test_treasury_output(wrong_slot_datum, treasury_value())
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(utxo_ref, treasury_in_output)

  let remaining =
    [Contribution { claimable_at: 3000, claimable_amount: 2_000_000 }]
  let updated_datum = build_treasury_state(1, group_ref_tn(), remaining)
  let treasury_out_value =
    assets.from_lovelace(1_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_out = test_treasury_output(updated_datum, treasury_out_value)
  let borrower_out = test_borrower_output()

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [treasury_in],
      reference_inputs: [group_ref_input],
      outputs: [treasury_out, borrower_out],
      validity_range: interval.after(current_time),
    }

  validate_distribute_payout(tp, 0, [0], [0], 1, wrong_slot_datum, utxo_ref, tx)
}

// Duplicate output indices: both indices point to output 0 — indices_in_ascending_order fails
test distribute_payout__rejects_duplicate_output_index() {
  let tp = treasury_policy()
  let (tx, datum, utxo) = setup_distribute_payout()
  !validate_distribute_payout(tp, 0, [0], [0, 0], 1, datum, utxo, tx)
}

// ─── validate_exit_group ──────────────────────────────────────────────────────

// Early exit: group is_active && current_time < maturity (0 + 3*1000 = 3000)
// Penalty output holds ≥ penalty_fee; member reclaims the remainder as change.
// member_count decrements immediately — slot freed, rotation continues unblocked.
test exit_group__accepts_early_exit_with_penalty() {
  let tp = treasury_policy()
  let gp = group_policy()

  let current_time = 1500
  // Group input with member_count: 1 (the exiting member)
  let active_group_datum = GroupDatum { ..test_group_datum(), member_count: 1 }
  let group_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
        output_index: 0,
      },
      output: Output {
        address: Address {
          payment_credential: Script(gp),
          stake_credential: None,
        },
        value: assets.from_lovelace(2_000_000)
          |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
        datum: InlineDatum(active_group_datum),
        reference_script: None,
      },
    }
  let member_input = test_member_input()

  let datum = test_treasury_state(0)

  let penalty_datum =
    PenaltyState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
    }
  // Penalty output holds exactly penalty_fee (500K ADA) + membership token.
  // Remaining locked contributions flow back to the member as change.
  let penalty_value =
    assets.from_lovelace(500_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let penalty_output =
    Output {
      address: Address {
        payment_credential: Script(tp),
        stake_credential: None,
      },
      value: penalty_value,
      datum: InlineDatum(penalty_datum),
      reference_script: None,
    }

  // Group output: member_count 1 → 0 (slot freed immediately)
  let group_out = test_group_output(0)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [penalty_output, group_out],
      validity_range: interval.after(current_time),
    }

  // group_ref_input_index=0, group_output_index=1, member_input_index=1, penalty_output_index=0
  validate_exit_group(tp, account_policy(), 0, 1, 1, 0, datum, tx)
}

// Mature exit: group is_active=False → burn path
test exit_group__accepts_mature_exit_with_burn() {
  let tp = treasury_policy()

  // Group is inactive with 1 member (the member being exited)
  let inactive_group_datum =
    GroupDatum { ..test_group_datum(), is_active: False, member_count: 1 }
  let gp = group_policy()
  let inactive_group_output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(inactive_group_datum),
      reference_script: None,
    }
  let group_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
        output_index: 0,
      },
      output: inactive_group_output,
    }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)

  // Burn the membership token
  let mint = assets.from_asset(tp, member_tn(), -1)

  // Group output: member_count 1 → 0 (mature exit decrements)
  let group_out = test_group_output(0)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [group_out],
      mint,
      validity_range: interval.after(500),
    }

  // group_ref_input_index=0, group_output_index=0, member_input_index=1, penalty_output_index=0
  validate_exit_group(tp, account_policy(), 0, 0, 1, 0, datum, tx)
}

// fail: expect TreasuryState crashes when datum is PenaltyState
test exit_group__rejects_penalty_state_datum() fail {
  let tp = treasury_policy()

  let current_time = 1500
  let group_input = test_group_input()
  let member_input = test_member_input()

  let penalty_datum =
    PenaltyState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
    }

  let group_out = test_group_output(0)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [group_out],
      validity_range: interval.after(current_time),
    }

  // Crashes on `expect TreasuryState` before reaching group output check
  validate_exit_group(tp, account_policy(), 0, 0, 1, 0, penalty_datum, tx)
}

// Member input holds no token matching member_reference_tokenname
// → member_authorized (member_has_user_token) check fails
test exit_group__rejects_member_input_without_user_token() {
  let tp = treasury_policy()

  let current_time = 1500
  // member_count: 1 so the decrement (→ 0) is valid; test fails on member_authorized only
  let group_input = test_group_input_with_member_count(1)

  // Member input holds only ADA — no account user token
  let no_token_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"2222222222222222222222222222222222222222222222222222222222222222",
        output_index: 0,
      },
      output: Output {
        address: Address {
          payment_credential: VerificationKey(common.test_pkh()),
          stake_credential: None,
        },
        value: assets.from_lovelace(2_000_000),
        datum: NoDatum,
        reference_script: None,
      },
    }

  let datum = test_treasury_state(0)

  let penalty_datum =
    PenaltyState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
    }
  let penalty_value =
    assets.from_lovelace(500_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let penalty_output =
    Output {
      address: Address {
        payment_credential: Script(tp),
        stake_credential: None,
      },
      value: penalty_value,
      datum: InlineDatum(penalty_datum),
      reference_script: None,
    }

  // Group output: member_count 1 → 0 (early exit now decrements)
  let group_out = test_group_output(0)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, no_token_input],
      outputs: [penalty_output, group_out],
      validity_range: interval.after(current_time),
    }

  !validate_exit_group(tp, account_policy(), 0, 1, 1, 0, datum, tx)
}

// Mature exit path: group inactive but no burn — should fail
test exit_group__rejects_mature_exit_without_burn() {
  let tp = treasury_policy()

  let inactive_group_datum =
    GroupDatum { ..test_group_datum(), is_active: False, member_count: 1 }
  let gp = group_policy()
  let inactive_group_output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(inactive_group_datum),
      reference_script: None,
    }
  let group_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
        output_index: 0,
      },
      output: inactive_group_output,
    }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)

  // Group output: member_count 1 → 0 (correct decrement, but token_burned fails)
  let group_out = test_group_output(0)

  // No burn in mint — mature exit without burning the token
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [group_out],
      mint: assets.zero,
      validity_range: interval.after(500),
    }

  !validate_exit_group(tp, account_policy(), 0, 0, 1, 0, datum, tx)
}

test exit_group__rejects_early_exit_missing_penalty_fee() {
  let tp = treasury_policy()

  let current_time = 1500
  let group_input = test_group_input_with_member_count(1)
  let member_input = test_member_input()

  let datum = test_treasury_state(0)

  let penalty_datum =
    PenaltyState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
    }
  // Penalty output with NO ADA — penalty_fee_locked (500K required) fails.
  let penalty_value = assets.from_asset(tp, member_tn(), 1)
  let penalty_output =
    Output {
      address: Address {
        payment_credential: Script(tp),
        stake_credential: None,
      },
      value: penalty_value,
      datum: InlineDatum(penalty_datum),
      reference_script: None,
    }

  // Group output: member_count unchanged (penalty path)
  let group_out = test_group_output(0)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [penalty_output, group_out],
      validity_range: interval.after(current_time),
    }

  !validate_exit_group(tp, account_policy(), 0, 1, 1, 0, datum, tx)
}

// Spec [ExitGroup 4a]: penalty output holds only penalty_fee (500K ADA) — member
// reclaims remaining locked contributions as wallet change. Valid per spec.
// member_count decrements immediately so the group rotation continues unblocked.
test exit_group__accepts_member_reclaims_refund() {
  let tp = treasury_policy()

  let current_time = 1500
  let group_input = test_group_input_with_member_count(1)
  let member_input = test_member_input()
  let datum = test_treasury_state(0)

  let penalty_datum =
    PenaltyState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
    }
  // Penalty output holds exactly penalty_fee (500K) — spec allows member to reclaim the rest
  let penalty_value =
    assets.from_lovelace(500_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let penalty_output =
    Output {
      address: Address {
        payment_credential: Script(tp),
        stake_credential: None,
      },
      value: penalty_value,
      datum: InlineDatum(penalty_datum),
      reference_script: None,
    }

  let group_out = test_group_output(0)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, member_input],
      outputs: [penalty_output, group_out],
      validity_range: interval.after(current_time),
    }

  validate_exit_group(tp, account_policy(), 0, 1, 1, 0, datum, tx)
}

// ─── validate_member_withdraw ─────────────────────────────────────────────────

fn setup_member_withdraw() -> (Transaction, TreasuryDatum, OutputReference) {
  let tp = treasury_policy()
  let gp = group_policy()

  // current_time = 1500 → entry at 1000 is claimable (2M), entry at 2000 is not
  let current_time = 1500

  // Group as reference input
  let group_ref_output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(test_group_datum()),
      reference_script: None,
    }
  let group_ref_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"4444444444444444444444444444444444444444444444444444444444444444",
        output_index: 0,
      },
      output: group_ref_output,
    }

  let member_input = test_member_input()

  // Treasury input with 5M ADA
  let datum = test_treasury_state(0)
  let treasury_in_output = test_treasury_output(datum, treasury_value())
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(utxo_ref, treasury_in_output)

  // Treasury output: 5M - 2M = 3M ADA + membership token; datum with entry at 1000 removed
  let remaining =
    [
      Contribution { claimable_at: 2000, claimable_amount: 2_000_000 },
      Contribution { claimable_at: 3000, claimable_amount: 2_000_000 },
    ]
  let updated_datum = build_treasury_state(0, group_ref_tn(), remaining)
  let treasury_out_value =
    assets.from_lovelace(3_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_out = test_treasury_output(updated_datum, treasury_out_value)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [treasury_in, member_input],
      reference_inputs: [group_ref_input],
      outputs: [treasury_out],
      validity_range: interval.after(current_time),
    }

  (tx, datum, utxo_ref)
}

test member_withdraw__accepts_valid_withdrawal() {
  let (tx, datum, utxo) = setup_member_withdraw()
  validate_member_withdraw(
    treasury_policy(),
    account_policy(),
    // group_ref_input_index (in reference_inputs)
    0,
    // member_input_index (in inputs)
    1,
    // treasury_output_index
    0,
    // withdrawal_amount
    2_000_000,
    datum,
    utxo,
    tx,
  )
}

test member_withdraw__rejects_over_withdrawal() {
  let (tx, datum, utxo) = setup_member_withdraw()
  // 3M > 2M claimable → should fail
  !validate_member_withdraw(
    treasury_policy(),
    account_policy(),
    0,
    1,
    0,
    3_000_000,
    datum,
    utxo,
    tx,
  )
}

test member_withdraw__rejects_zero_withdrawal() {
  let (tx, datum, utxo) = setup_member_withdraw()
  // loans_withdrawn must be > 0
  !validate_member_withdraw(
    treasury_policy(),
    account_policy(),
    0,
    1,
    0,
    0,
    datum,
    utxo,
    tx,
  )
}

// fail: expect TreasuryState crashes when datum is PenaltyState
test member_withdraw__rejects_penalty_state_datum() fail {
  let (tx, _, utxo) = setup_member_withdraw()
  let penalty_datum =
    PenaltyState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
    }
  validate_member_withdraw(
    treasury_policy(),
    account_policy(),
    0,
    1,
    0,
    2_000_000,
    penalty_datum,
    utxo,
    tx,
  )
}

// Member input holds no token matching member_reference_tokenname
// → member_authorized check fails
test member_withdraw__rejects_member_input_without_user_token() {
  let tp = treasury_policy()
  let gp = group_policy()

  let current_time = 1500
  let group_ref_output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(test_group_datum()),
      reference_script: None,
    }
  let group_ref_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"4444444444444444444444444444444444444444444444444444444444444444",
        output_index: 0,
      },
      output: group_ref_output,
    }

  // Member input holds only ADA — no account user token
  let no_token_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"2222222222222222222222222222222222222222222222222222222222222222",
        output_index: 0,
      },
      output: Output {
        address: Address {
          payment_credential: VerificationKey(common.test_pkh()),
          stake_credential: None,
        },
        value: assets.from_lovelace(2_000_000),
        datum: NoDatum,
        reference_script: None,
      },
    }

  let datum = test_treasury_state(0)
  let treasury_in_output = test_treasury_output(datum, treasury_value())
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(utxo_ref, treasury_in_output)

  let remaining =
    [
      Contribution { claimable_at: 2000, claimable_amount: 2_000_000 },
      Contribution { claimable_at: 3000, claimable_amount: 2_000_000 },
    ]
  let updated_datum = build_treasury_state(0, group_ref_tn(), remaining)
  let treasury_out_value =
    assets.from_lovelace(3_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_out = test_treasury_output(updated_datum, treasury_out_value)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [treasury_in, no_token_input],
      reference_inputs: [group_ref_input],
      outputs: [treasury_out],
      validity_range: interval.after(current_time),
    }

  !validate_member_withdraw(
    treasury_policy(),
    account_policy(),
    0,
    1,
    0,
    2_000_000,
    datum,
    utxo_ref,
    tx,
  )
}

// Output contribution list is NOT updated (stale datum) — entries not pruned
// → datum_updated check fails
test member_withdraw__rejects_wrong_datum_update() {
  let (tx, datum, utxo) = setup_member_withdraw()
  let Transaction { inputs, reference_inputs, outputs, validity_range, .. } = tx
  // Replace treasury output datum with the original (unpruned) contribution list
  expect Some(old_out) = list.at(outputs, 0)
  let stale_datum = test_treasury_state(0)
  let bad_out = Output { ..old_out, datum: InlineDatum(stale_datum) }
  let bad_tx =
    Transaction {
      ..transaction.placeholder,
      inputs,
      reference_inputs,
      outputs: [bad_out],
      validity_range,
    }
  !validate_member_withdraw(
    treasury_policy(),
    account_policy(),
    0,
    1,
    0,
    2_000_000,
    datum,
    utxo,
    bad_tx,
  )
}

// Inactive group: member withdraws all remaining contributions and burns their token
test member_withdraw__accepts_inactive_group_full_withdrawal() {
  let tp = treasury_policy()
  let gp = group_policy()

  let inactive_group_datum =
    GroupDatum { ..test_group_datum(), is_active: False }
  let group_ref_output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(inactive_group_datum),
      reference_script: None,
    }
  let group_ref_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"4444444444444444444444444444444444444444444444444444444444444444",
        output_index: 0,
      },
      output: group_ref_output,
    }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)
  let treasury_in_output = test_treasury_output(datum, treasury_value())
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(utxo_ref, treasury_in_output)

  // Burn the membership token — no output needed (inactive exit)
  let mint = assets.from_asset(tp, member_tn(), -1)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [treasury_in, member_input],
      reference_inputs: [group_ref_input],
      outputs: [],
      mint,
      validity_range: interval.after(500),
    }

  // loans_withdrawn = 0 on inactive path (burn path doesn't check amount)
  validate_member_withdraw(
    tp,
    account_policy(),
    0,
    1,
    0,
    0,
    datum,
    utxo_ref,
    tx,
  )
}

// Inactive group: member tries to exit without burning — must fail
test member_withdraw__rejects_inactive_group_no_burn() {
  let tp = treasury_policy()
  let gp = group_policy()

  let inactive_group_datum =
    GroupDatum { ..test_group_datum(), is_active: False }
  let group_ref_output =
    Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(inactive_group_datum),
      reference_script: None,
    }
  let group_ref_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"4444444444444444444444444444444444444444444444444444444444444444",
        output_index: 0,
      },
      output: group_ref_output,
    }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)
  let treasury_in_output = test_treasury_output(datum, treasury_value())
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(utxo_ref, treasury_in_output)

  // No burn — inactive path requires exactly 1 burn
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [treasury_in, member_input],
      reference_inputs: [group_ref_input],
      outputs: [],
      mint: assets.zero,
      validity_range: interval.after(500),
    }

  !validate_member_withdraw(
    tp,
    account_policy(),
    0,
    1,
    0,
    0,
    datum,
    utxo_ref,
    tx,
  )
}

// Output ADA doesn't decrease by loans_withdrawn — balance check fails
test member_withdraw__rejects_wrong_ada_balance() {
  let (tx, datum, utxo) = setup_member_withdraw()
  let Transaction { inputs, reference_inputs, outputs, validity_range, .. } = tx
  // Treasury output keeps full 5M ADA instead of 5M - 2M = 3M
  expect Some(old_out) = list.at(outputs, 0)
  let wrong_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(treasury_policy(), member_tn(), 1))
  let bad_out = Output { ..old_out, value: wrong_value }
  let bad_tx =
    Transaction {
      ..transaction.placeholder,
      inputs,
      reference_inputs,
      outputs: [bad_out],
      validity_range,
    }
  !validate_member_withdraw(
    treasury_policy(),
    account_policy(),
    0,
    1,
    0,
    2_000_000,
    datum,
    utxo,
    bad_tx,
  )
}

// ─── validate_spend_terminate_group ──────────────────────────────────────────

test spend_terminate_group__accepts_penalty_burn() {
  let tp = treasury_policy()
  let datum =
    PenaltyState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
    }
  let mint = assets.from_asset(tp, member_tn(), -1)
  validate_spend_terminate_group(
    tp,
    datum,
    group_policy(),
    0,
    [test_admin_input()],
    mint,
  )
}

// fail: expect PenaltyState crashes when datum is TreasuryState
test spend_terminate_group__rejects_treasury_state_datum() fail {
  let tp = treasury_policy()
  let datum = test_treasury_state(0)
  let mint = assets.from_asset(tp, member_tn(), -1)
  validate_spend_terminate_group(
    tp,
    datum,
    group_policy(),
    0,
    [test_admin_input()],
    mint,
  )
}

test spend_terminate_group__rejects_no_burn() {
  let tp = treasury_policy()
  let datum =
    PenaltyState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
    }
  // No burn in mint
  let mint = assets.zero
  !validate_spend_terminate_group(
    tp,
    datum,
    group_policy(),
    0,
    [test_admin_input()],
    mint,
  )
}

test spend_terminate_group__rejects_wrong_token_burned() {
  let tp = treasury_policy()
  let datum =
    PenaltyState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
    }
  // Burning a different token name
  let wrong_tn = #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  let mint = assets.from_asset(tp, wrong_tn, -1)
  !validate_spend_terminate_group(
    tp,
    datum,
    group_policy(),
    0,
    [test_admin_input()],
    mint,
  )
}

// Admin input holds no group (222) token — authorization check fails
test spend_terminate_group__rejects_no_admin_token() {
  let tp = treasury_policy()
  let datum =
    PenaltyState {
      group_reference_tokenname: group_ref_tn(),
      member_reference_tokenname: member_tn(),
    }
  // Admin input at correct address but holds no admin token
  let no_token_admin_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
        output_index: 0,
      },
      output: Output {
        address: Address {
          payment_credential: VerificationKey(common.test_pkh()),
          stake_credential: None,
        },
        value: assets.from_lovelace(2_000_000),
        datum: NoDatum,
        reference_script: None,
      },
    }
  let mint = assets.from_asset(tp, member_tn(), -1)
  !validate_spend_terminate_group(
    tp,
    datum,
    group_policy(),
    0,
    [no_token_admin_input],
    mint,
  )
}
