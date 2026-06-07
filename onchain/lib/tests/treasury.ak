use aiken/collection/list
use aiken/interval
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use dcu/cip68
use dcu/group.{GroupCip68Datum, GroupDatum, Pull, Push}
use dcu/treasury.{
  DefaultState, PenaltyState, TreasuryDatum, TreasuryState, max_grace_extensions,
}
use dcu/treasury_utils.{min_ada_reserve}
use dcu/treasury_validation.{
  validate_claim_payout, validate_claim_penalty, validate_claim_penalty_mint,
  validate_contribute, validate_distribute_treasury, validate_exit_treasury,
  validate_extend_grace, validate_join_treasury, validate_next_cycle_treasury,
  validate_terminate_default, validate_update_payout,
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

// Group datum for treasury tests. is_started=False (join tests need this).
// num_rounds=3 kept so exit tests compute maturity_time = 0+3*1000 = 3000 correctly.
// Distribute tests override is_started=True and last_distributed_round=-1.
fn test_group_datum() -> GroupDatum {
  GroupDatum {
    contribution_fee_policyid: assets.ada_policy_id,
    contribution_fee_assetname: #"",
    contribution_fee: 2_000_000,
    joining_fee_policyid: assets.ada_policy_id,
    joining_fee_assetname: #"",
    joining_fee: 0,
    penalty_fee_policyid: assets.ada_policy_id,
    penalty_fee_assetname: #"",
    penalty_fee: 500_000,
    grace_period_length: 0,
    creator_bond: 0,
    interval_length: 1000,
    num_rounds: 3,
    max_members: 30,
    member_count: 0,
    is_active: True,
    is_started: False,
    start_time: 0,
    last_distributed_round: -1,
    creator_payment_credential: common.test_pkh(),
    member_token_names: [],
    collateral_rounds: 1,
    payout_mode: Push,
  }
}

fn test_group_cip68_datum() -> GroupCip68Datum {
  GroupCip68Datum {
    metadata: [Pair(#"6e616d65", "Test Group")],
    version: 1,
    extra: test_group_datum(),
  }
}

fn cip68_with_group(extra: GroupDatum) -> GroupCip68Datum {
  GroupCip68Datum { ..test_group_cip68_datum(), extra }
}

// Group UTxO at Script(group_policy) holding the ref token
fn test_group_input() -> Input {
  let gp = group_policy()
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value,
    datum: InlineDatum(test_group_cip68_datum()),
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

// [security C1/C2/C3] Attacker's FORGED group: a fake always-succeeds script holding a
// token with the victim's PUBLIC group name (group_ref_tn) minted under the ATTACKER's
// own policy, carrying a valid-looking datum. The token-name check alone would pass — the
// trusted-binding assertion (group input must sit at Script(trusted_group_policy)) is what
// rejects it. Used by the *__rejects_fake_group_script negatives.
fn fake_group_policy() -> assets.PolicyId {
  #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
}

fn fake_group_input() -> Input {
  let fp = fake_group_policy()
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(fp, group_ref_tn(), 1))
  let output = Output {
    address: Address { payment_credential: Script(fp), stake_credential: None },
    value,
    datum: InlineDatum(test_group_cip68_datum()),
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

// --- Native-token contribution group fixtures ---
// A group whose contribution asset is a native token (not ADA), fee = 1000 units.
fn token_policy() -> assets.PolicyId {
  #"04040404040404040404040404040404040404040404040404040404"
}

fn token_name() -> assets.AssetName {
  #"746f6b656e"
}

fn token_group_datum() -> GroupDatum {
  GroupDatum {
    ..test_group_datum(),
    contribution_fee_policyid: token_policy(),
    contribution_fee_assetname: token_name(),
    contribution_fee: 1000,
  }
}

// Group reference input advertising the native-token contribution asset.
fn token_group_input() -> Input {
  let gp = group_policy()
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value,
    datum: InlineDatum(cip68_with_group(token_group_datum())),
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

// Treasury value: min ADA + membership token + `token_amount` native contribution tokens.
fn token_treasury_value(token_amount: Int) -> assets.Value {
  assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(treasury_policy(), member_tn(), 1))
    |> assets.merge(
        assets.from_asset(token_policy(), token_name(), token_amount),
      )
}

// Core builder — single definition point for TreasuryState test datums.
fn build_treasury_state(
  assigned_slot: Int,
  group_ref_token: assets.AssetName,
  rounds_paid: Int,
) -> TreasuryDatum {
  TreasuryState {
    group_reference_tokenname: group_ref_token,
    member_reference_tokenname: member_tn(),
    assigned_slot,
    rounds_paid,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 0,
  }
}

// Convenience wrapper: standard group token, zero rounds
fn test_treasury_state(assigned_slot: Int) -> TreasuryDatum {
  build_treasury_state(assigned_slot, group_ref_tn(), 0)
}

// DefaultState datum for extend_grace_window and contribute recovery tests
fn test_insufficient_collateral_state() -> TreasuryDatum {
  DefaultState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    grace_expires_at: 5000,
    grace_extensions_used: 0,
    rounds_paid: 0,
    assigned_slot: 0,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 0,
  }
}

// Treasury UTxO value: the min-ADA reserve that carries the membership token, plus
// 5 ADA of *contributable* collateral, plus 1 membership token. Expressing the reserve
// explicitly keeps the contributable balance (what the conservation math measures) at 5M
// after the validator excludes the reserve.
fn treasury_value() -> assets.Value {
  assets.from_lovelace(min_ada_reserve + 5_000_000)
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
  let output = Output {
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
fn test_group_output(member_count: Int) -> Output {
  let gp = group_policy()
  let datum = cip68_with_group(
    GroupDatum { ..test_group_datum(), member_count },
  )
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

// Borrower output at a wallet address (4M ADA — satisfies >= 2M contribution_fee check)
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

// Group admin (222) token name — derived from group_ref_tn() via CIP-68 conversion
fn group_admin_tn() -> assets.AssetName {
  cip68.convert_ref_to_user_token(group_ref_tn())
}

// Admin input holding the group user (222) token under group_policy
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

// Helper: builds a group Input with an overridden member_count
fn test_group_input_with_member_count(member_count: Int) -> Input {
  let gp = group_policy()
  let datum = cip68_with_group(
    GroupDatum { ..test_group_datum(), member_count },
  )
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
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

// Group reference input with a custom collateral_rounds (FullUpfront / partial tests).
fn group_input_collateral(cr: Int) -> Input {
  let gp = group_policy()
  let datum = cip68_with_group(
    GroupDatum { ..test_group_datum(), collateral_rounds: cr },
  )
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
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

// ─── validate_claim_penalty_mint (mint: burn path) ───────────────────────────────

test terminate_group__accepts_valid_burn() {
  let mint = assets.from_asset(treasury_policy(), member_tn(), -1)
  validate_claim_penalty_mint(treasury_policy(), mint)
}

/// validate_terminate_group returns False (not crash) when qty != -1 — use !
test terminate_group__rejects_positive_qty() {
  let mint = assets.from_asset(treasury_policy(), member_tn(), 1)
  !validate_claim_penalty_mint(treasury_policy(), mint)
}

// fail annotation: expect crashes when two tokens in the dict
test terminate_group__rejects_two_tokens_burned() fail {
  let other_tn = #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  let mint = assets.from_asset(treasury_policy(), member_tn(), -1)
    |> assets.merge(assets.from_asset(treasury_policy(), other_tn, -1))
  validate_claim_penalty_mint(treasury_policy(), mint)
}

// ─── validate_join_group ──────────────────────────────────────────────────────

test join_group__accepts_valid_join() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  // Value: enough ADA for contribution_fee (2M) + treasury token; joining_fee = 0
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  // Group output: member_count 0 → 1
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  // group_ref_input_index=0, group_output_index=1, member_input_index=1, treasury_output_index=0
  validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// [security C2] Same as the valid join EXCEPT the group spending input is the attacker's
// forged group at a fake script (token name matches, policy does not) → rejected by the
// trusted-binding assertion before any membership state can change.
test join_group__rejects_fake_group_script() fail {
  let tp = treasury_policy()

  let group_input = fake_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_wrong_member_count_slot() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  // assigned_slot = 1 but group.member_count = 0
  let datum = test_treasury_state(1)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// rounds_paid != 0 at join time — validator rejects (fresh member must have rounds_paid == 0)
test join_group__rejects_nonzero_rounds_paid() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  // rounds_paid = 1 — must be 0 at join
  let bad_datum = build_treasury_state(0, group_ref_tn(), 1)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(bad_datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// Group is already started — startGroup seals membership, late joins rejected
test join_group__rejects_started_group() {
  let tp = treasury_policy()
  let gp = group_policy()

  let started_datum = GroupDatum { ..test_group_datum(), is_started: True }
  let group_input = Input {
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
      datum: InlineDatum(cip68_with_group(started_datum)),
      reference_script: None,
    },
  }
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..started_datum, member_count: 1 }),
    ),
    reference_script: None,
  }
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_extra_token_minted() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let other_tn = #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  let mint = assets.from_asset(tp, member_tn(), 1)
    |> assets.merge(assets.from_asset(tp, other_tn, 1))

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_insufficient_fees() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  // Only 1 ADA — not enough for 2M contribution_fee required
  let output_value = assets.from_lovelace(1_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// FullUpfront / partial: with collateral_rounds = 3 the join floor is 3 × 2M = 6M.
// A 5M deposit is below the floor → rejected.
test join_group__rejects_below_collateral_rounds() {
  let tp = treasury_policy()

  let group_input = group_input_collateral(3)
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// Same group (collateral_rounds = 3): a 6M deposit meets the full floor → accepted.
test join_group__accepts_full_collateral() {
  let tp = treasury_policy()

  let group_input = group_input_collateral(3)
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  // 6M contributable meets the 3 × 2M floor; reserve carries the membership token.
  let output_value = assets.from_lovelace(min_ada_reserve + 6_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// [B3] Join floor requires the min-ADA reserve ON TOP of the contribution collateral.
// A deposit of exactly contribution_fee (2M) has contributable == 0 < the 2M floor → rejected.
// Pre-B3 this passed (raw 2M >= 2M), letting a member join with no spendable headroom and
// brick the final round on min-ADA. The reserve makes the floor count only real collateral.
test join_group__rejects_deposit_without_reserve() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  // Exactly the contribution_fee, no reserve → contributable == 0.
  let output_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// joining_fee > 0 but no output at creator_payment_credential — joining_fee_routed fails
test join_group__rejects_joining_fee_not_routed_to_admin() {
  let tp = treasury_policy()

  // Override joining_fee to 1M — requires an admin payment output
  let group_datum_with_fee = GroupDatum {
    ..test_group_datum(),
    joining_fee: 1_000_000,
  }
  let gp = group_policy()
  let group_input = Input {
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
      datum: InlineDatum(cip68_with_group(group_datum_with_fee)),
      reference_script: None,
    },
  }
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  let output_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum_with_fee, member_count: 1 }),
    ),
    reference_script: None,
  }
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    // No admin payment output — joining_fee_routed must fail
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// joining_fee > 0 and admin output at creator_payment_credential — should pass
test join_group__accepts_joining_fee_routed_to_admin() {
  let tp = treasury_policy()

  let group_datum_with_fee = GroupDatum {
    ..test_group_datum(),
    joining_fee: 1_000_000,
  }
  let gp = group_policy()
  let group_input = Input {
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
      datum: InlineDatum(cip68_with_group(group_datum_with_fee)),
      reference_script: None,
    },
  }
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  // 2M contributable meets the 1 × 2M floor; reserve carries the membership token.
  let output_value = assets.from_lovelace(min_ada_reserve + 2_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum_with_fee, member_count: 1 }),
    ),
    reference_script: None,
  }
  // Admin payment output at creator_payment_credential (test_pkh) with >= joining_fee (1M)
  let admin_output = Output {
    address: Address {
      payment_credential: VerificationKey(common.test_pkh()),
      stake_credential: None,
    },
    value: assets.from_lovelace(1_000_000),
    datum: NoDatum,
    reference_script: None,
  }
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out, admin_output],
    mint,
    validity_range: interval.after(0),
  }

  validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// Group is deactivated — group_active check fails
test join_group__rejects_inactive_group() {
  let tp = treasury_policy()
  let gp = group_policy()

  let inactive_datum = GroupDatum { ..test_group_datum(), is_active: False }
  let inactive_group_input = Input {
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
      datum: InlineDatum(cip68_with_group(inactive_datum)),
      reference_script: None,
    },
  }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [inactive_group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// Group is at max capacity (member_count == max_members) — join must be rejected
test join_group__rejects_group_at_capacity() {
  let tp = treasury_policy()
  let gp = group_policy()

  let full_datum = GroupDatum {
    ..test_group_datum(),
    max_members: 3,
    member_count: 3,
  }
  let full_group_input = Input {
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
      datum: InlineDatum(cip68_with_group(full_datum)),
      reference_script: None,
    },
  }

  let member_input = test_member_input()
  let datum = test_treasury_state(3)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..full_datum, member_count: 4 }),
    ),
    reference_script: None,
  }
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [full_group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_token_stuffing_in_output() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  let other_tn = #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  // Two tokens under the treasury policy — violates exact token check
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
    |> assets.merge(assets.from_asset(tp, other_tn, 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)

  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_output_at_wallet() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  let datum = test_treasury_state(0)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  // Treasury output sent to wallet instead of script
  let bad_output = Output {
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

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [bad_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_member_input_without_account_nft() {
  let tp = treasury_policy()

  let group_input = test_group_input()

  // Member input holds only ADA — no account user token
  let wallet_only_input = Input {
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
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, wallet_only_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

test join_group__rejects_wrong_group_link() {
  let tp = treasury_policy()

  let group_input = test_group_input()
  let member_input = test_member_input()

  // datum group_reference_tokenname doesn't match the actual group token
  let wrong_group_tn = #"ffff00ffff00ffff00ffff00ffff00ffff00ffff00ffff00ffff00"
  let datum = build_treasury_state(0, wrong_group_tn, 0)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(1)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// Group already has member_tn() in member_token_names — same account cannot join twice
test join_group__rejects_duplicate_member() {
  let tp = treasury_policy()
  let gp = group_policy()

  let group_datum_with_member = GroupDatum {
    ..test_group_datum(),
    member_count: 1,
    member_token_names: [member_tn()],
  }
  let group_input = Input {
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
      datum: InlineDatum(cip68_with_group(group_datum_with_member)),
      reference_script: None,
    },
  }
  let member_input = test_member_input()

  // assigned_slot=1 satisfies slot_valid (== group.member_count=1) but duplicate check fails
  let datum = test_treasury_state(1)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(2)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// ─── member_count / cross-validator state transition tests ────────────────────

// Sequential slot assignment: the second member's assigned_slot must equal
// group.member_count (1) at the time they join.
test join_group__second_member_gets_sequential_slot() {
  let tp = treasury_policy()

  let group_input = test_group_input_with_member_count(1)
  let member_input = test_member_input()

  // Second member claims slot 1 (== member_count) — correct
  let datum = test_treasury_state(1)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  // Group output: member_count 1 → 2
  let group_out = test_group_output(2)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// Slot collision guard: a second joiner must NOT be able to claim slot 0
// (already assigned to the first member) when group.member_count is 1.
test join_group__rejects_slot_collision_with_existing_member() {
  let tp = treasury_policy()

  let group_input = test_group_input_with_member_count(1)
  let member_input = test_member_input()

  // Attempted: assigned_slot = 0 — collides with existing member
  let datum = test_treasury_state(0)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let group_out = test_group_output(2)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, group_out],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// Group output with non-incremented member_count must be rejected.
test join_group__rejects_group_output_without_member_count_increment() {
  let tp = treasury_policy()

  let group_input = test_group_input()

  // Group output: member_count still 0 — not incremented → must be rejected
  let unchanged_group_output = Output {
    address: group_input.output.address,
    value: group_input.output.value,
    datum: InlineDatum(test_group_cip68_datum()),
    reference_script: None,
  }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)
  let output_value = assets.from_lovelace(5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_output = test_treasury_output(datum, output_value)
  let mint = assets.from_asset(tp, member_tn(), 1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [treasury_output, unchanged_group_output],
    mint,
    validity_range: interval.after(0),
  }

  !validate_join_treasury(tp, account_policy(), group_policy(), 0, 1, 1, 0, tx)
}

// ─── validate_distribute ────────────────────────────────────────────────
//
// Setup: round_number = 0, group.num_rounds = 3
// current_slot = 0 % 3 = 0 → borrower has assigned_slot = 0
// Treasury input: 5M ADA, rounds_paid = 0
// Treasury output: 3M ADA (5M - 2M contribution_fee), rounds_paid = 1, is_deferred = False
// Group input: last_distributed_round = -1 → group output: last_distributed_round = 0
// Borrower receives 2M (1 member × 2M contribution_fee)
//
// Indices: inputs=[group(0), treasury(1)], outputs=[treasury_out(0), group_out(1), borrower(2)]

fn setup_distribute_round() -> (Transaction, TreasuryDatum, OutputReference) {
  let tp = treasury_policy()
  let gp = group_policy()

  // Group as spending INPUT — last_distributed_round will be updated to 0.
  // member_token_names lists the single member so active_members (pro-rata) = 1.
  let group_datum = GroupDatum {
    ..test_group_datum(),
    num_rounds: 3,
    is_started: True,
    last_distributed_round: -1,
    member_token_names: [member_tn()],
  }
  let group_in_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: group_in_value,
      datum: InlineDatum(cip68_with_group(group_datum)),
      reference_script: None,
    },
  }

  // Group output: last_distributed_round updated to round_number (0)
  let group_output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: group_in_value,
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum, last_distributed_round: 0 }),
    ),
    reference_script: None,
  }

  // Treasury input: assigned_slot = 0 (borrower for round 0), rounds_paid = 0
  let treasury_datum = build_treasury_state(0, group_ref_tn(), 0)
  let treasury_in_value = treasury_value()
  let treasury_in_output = test_treasury_output(
    treasury_datum,
    treasury_in_value,
  )
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(utxo_ref, treasury_in_output)

  // Treasury output: rounds_paid = 1, contributable reduced by contribution_fee (5M → 3M),
  // with the min-ADA reserve retained to carry the membership token.
  let updated_treasury_datum = build_treasury_state(0, group_ref_tn(), 1)
  let treasury_out_value = assets.from_lovelace(min_ada_reserve + 3_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_out = test_treasury_output(
    updated_treasury_datum,
    treasury_out_value,
  )

  // Borrower receives total_payout (1 member × 2M = 2M); test_borrower_output has 4M ✓
  let borrower_out = test_borrower_output()

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, treasury_in],
    outputs: [treasury_out, group_output, borrower_out],
    validity_range: interval.after(0),
  }

  (tx, treasury_datum, utxo_ref)
}

// [security C2/C4] The headline theft path: a permissionless caller presents a FORGED
// group (fake always-succeeds script, the victim's group name minted under the attacker's
// own policy) to drive a real treasury's round. Everything else is a valid distribute —
// only the group input's script differs — and the trusted-binding assertion rejects it.
test distribute_round__rejects_fake_group_script() fail {
  let tp = treasury_policy()
  let fp = fake_group_policy()

  let group_datum = GroupDatum {
    ..test_group_datum(),
    num_rounds: 3,
    is_started: True,
    last_distributed_round: -1,
    member_token_names: [member_tn()],
  }
  let group_in_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(fp, group_ref_tn(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(fp),
        stake_credential: None,
      },
      value: group_in_value,
      datum: InlineDatum(cip68_with_group(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address { payment_credential: Script(fp), stake_credential: None },
    value: group_in_value,
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum, last_distributed_round: 0 }),
    ),
    reference_script: None,
  }
  let treasury_datum = build_treasury_state(0, group_ref_tn(), 0)
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(treasury_datum, treasury_value()),
  )
  let updated = build_treasury_state(0, group_ref_tn(), 1)
  let treasury_out_value = assets.from_lovelace(3_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_out = test_treasury_output(updated, treasury_out_value)
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, treasury_in],
    outputs: [treasury_out, group_output, test_borrower_output()],
    validity_range: interval.after(0),
  }

  validate_distribute_treasury(
    tp,
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    treasury_datum,
    treasury_utxo_ref(),
    tx,
  )
}

test distribute_round__accepts_valid_round() {
  let (tx, datum, utxo) = setup_distribute_round()
  validate_distribute_treasury(
    treasury_policy(),
    group_policy(),
    0,
    // group_ref_input_index
    0,
    // group_output_index
    1,
    // treasury_input_indices
    [1],
    // treasury_output_indices
    [0],
    // borrower_output_index
    2,
    datum,
    utxo,
    tx,
  )
}

// [B3] Final-round min-ADA: a member funded to exactly the round's fee enters the last
// round with contributable == fee, is debited fee, and lands at contributable == 0 while
// min_ada_reserve still carries the membership token. The output stays TreasuryState
// (is_last_round suppresses the ICS transition) so the member can mature-exit via burn.
// Pre-B3 this required the output lovelace to be 0, colliding with min-ADA → rejected.
test distribute_round__accepts_final_round_drains_to_reserve() {
  let tp = treasury_policy()
  let gp = group_policy()

  // Single-round group: round 0 is the final round (0 + 1 == num_rounds).
  let group_datum = GroupDatum {
    ..test_group_datum(),
    num_rounds: 1,
    is_started: True,
    last_distributed_round: -1,
    member_token_names: [member_tn()],
  }
  let group_in_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: group_in_value,
      datum: InlineDatum(cip68_with_group(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: group_in_value,
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum, last_distributed_round: 0 }),
    ),
    reference_script: None,
  }

  // Input: contributable == fee (2M) on top of the reserve.
  let treasury_datum = build_treasury_state(0, group_ref_tn(), 0)
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(
    utxo_ref,
    test_treasury_output(
      treasury_datum,
      assets.from_lovelace(min_ada_reserve + 2_000_000)
        |> assets.merge(assets.from_asset(tp, member_tn(), 1)),
    ),
  )
  // Output: contributable drained to 0, only the reserve remains; still TreasuryState.
  let treasury_out = test_treasury_output(
    build_treasury_state(0, group_ref_tn(), 1),
    assets.from_lovelace(min_ada_reserve)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1)),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, treasury_in],
    outputs: [treasury_out, group_output, test_borrower_output()],
    validity_range: interval.after(0),
  }

  validate_distribute_treasury(
    tp,
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    treasury_datum,
    utxo_ref,
    tx,
  )
}

// [B3 + B2] Mid-cycle DefaultState transition: a non-final round (0 of 3) debits the fee,
// dropping the member's *contributable* balance to 0 < fee, so the output datum must be
// DefaultState (not TreasuryState). This exercises the reserve-sensitive ICS threshold
// AND pins the grace_expires_at = get_lower_bound(tx) + grace_period_length that the B2
// terminate-default gate later depends on. (Distinct from the final-round case above,
// where is_last_round suppresses the transition and the member stays TreasuryState.)
test distribute_round__accepts_transition_to_default() {
  let tp = treasury_policy()
  let gp = group_policy()

  // Round 0 of 3 → NOT the last round, so an under-fee member transitions to DefaultState.
  let group_datum = GroupDatum {
    ..test_group_datum(),
    num_rounds: 3,
    is_started: True,
    last_distributed_round: -1,
    member_token_names: [member_tn()],
  }
  let group_in_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: group_in_value,
      datum: InlineDatum(cip68_with_group(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: group_in_value,
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum, last_distributed_round: 0 }),
    ),
    reference_script: None,
  }

  // Input: contributable == fee (2M) on top of the reserve; output drains contributable to 0.
  let treasury_datum = build_treasury_state(0, group_ref_tn(), 0)
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(
    utxo_ref,
    test_treasury_output(
      treasury_datum,
      assets.from_lovelace(min_ada_reserve + 2_000_000)
        |> assets.merge(assets.from_asset(tp, member_tn(), 1)),
    ),
  )
  // Output datum must be DefaultState: grace_expires_at = lower_bound (0) + grace_period (0),
  // rounds_paid = round_number + 1, slot/credential/claimable carried forward.
  let default_out_datum = DefaultState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    grace_expires_at: 0,
    grace_extensions_used: 0,
    rounds_paid: 1,
    assigned_slot: 0,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 0,
  }
  let treasury_out = test_treasury_output(
    default_out_datum,
    assets.from_lovelace(min_ada_reserve)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1)),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, treasury_in],
    outputs: [treasury_out, group_output, test_borrower_output()],
    validity_range: interval.after(0),
  }

  validate_distribute_treasury(
    tp,
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    treasury_datum,
    utxo_ref,
    tx,
  )
}

// fail: expect TreasuryState crashes when datum is PenaltyState
test distribute_round__rejects_penalty_state_datum() fail {
  let (tx, _, utxo) = setup_distribute_round()
  let penalty_datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }
  validate_distribute_treasury(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    penalty_datum,
    utxo,
    tx,
  )
}

// Treasury output retains full input ADA despite contribution round — balance_deducted fails
test distribute_round__rejects_no_ada_reduction() {
  let tp = treasury_policy()
  let (tx, datum, utxo) = setup_distribute_round()

  let Transaction { inputs, outputs, validity_range, .. } = tx
  // outputs[0] is the treasury out — replace with one that keeps the full input ADA
  // (reserve + 5M contributable), so balance_deducted fails: no contribution was paid.
  expect Some(old_treasury_out) = list.at(outputs, 0)
  let no_reduction_value = assets.from_lovelace(min_ada_reserve + 5_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let bad_treasury_out = Output {
    ..old_treasury_out,
    value: no_reduction_value,
  }
  let new_outputs = list.concat([bad_treasury_out], list.drop(outputs, 1))

  let bad_tx = Transaction {
    ..transaction.placeholder,
    inputs,
    outputs: new_outputs,
    validity_range,
  }

  !validate_distribute_treasury(
    tp,
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    datum,
    utxo,
    bad_tx,
  )
}

// Treasury output datum has stale rounds_paid (0 instead of 1) — output_datum_correct fails
test distribute_round__rejects_wrong_datum_update() {
  let tp = treasury_policy()
  let (tx, datum, utxo) = setup_distribute_round()

  let Transaction { inputs, outputs, validity_range, .. } = tx
  expect Some(old_treasury_out) = list.at(outputs, 0)
  // Datum with rounds_paid still 0 — not incremented
  let stale_datum = build_treasury_state(0, group_ref_tn(), 0)
  let bad_treasury_out = Output {
    ..old_treasury_out,
    datum: InlineDatum(stale_datum),
  }
  let new_outputs = list.concat([bad_treasury_out], list.drop(outputs, 1))

  let bad_tx = Transaction {
    ..transaction.placeholder,
    inputs,
    outputs: new_outputs,
    validity_range,
  }

  !validate_distribute_treasury(
    tp,
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    datum,
    utxo,
    bad_tx,
  )
}

// Borrower output at a script address instead of a wallet — borrower_at_correct_wallet fails
test distribute_round__rejects_borrower_output_at_script() {
  let tp = treasury_policy()
  let (tx, datum, utxo) = setup_distribute_round()

  let Transaction { inputs, outputs, validity_range, .. } = tx
  expect Some(old_borrower_out) = list.at(outputs, 2)
  let script_borrower = Output {
    ..old_borrower_out,
    address: Address { payment_credential: Script(tp), stake_credential: None },
  }
  let new_outputs = list.concat(list.take(outputs, 2), [script_borrower])

  let bad_tx = Transaction {
    ..transaction.placeholder,
    inputs,
    outputs: new_outputs,
    validity_range,
  }

  !validate_distribute_treasury(
    tp,
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    datum,
    utxo,
    bad_tx,
  )
}

// current_slot = 0, but only treasury input has assigned_slot = 1
// → list.find_map for borrower_cred returns None → expect Some crashes
test distribute_round__rejects_when_borrower_absent() fail {
  let tp = treasury_policy()
  let gp = group_policy()

  let group_datum = GroupDatum {
    ..test_group_datum(),
    num_rounds: 3,
    is_started: True,
    last_distributed_round: -1,
  }
  let group_in_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: group_in_value,
      datum: InlineDatum(cip68_with_group(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: group_in_value,
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum, last_distributed_round: 0 }),
    ),
    reference_script: None,
  }

  // assigned_slot = 1 — NOT the borrower for current_slot = 0
  let wrong_slot_datum = build_treasury_state(1, group_ref_tn(), 0)
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(wrong_slot_datum, treasury_value()),
  )
  let updated_datum = build_treasury_state(1, group_ref_tn(), 1)
  let treasury_out = test_treasury_output(
    updated_datum,
    assets.from_lovelace(3_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1)),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, treasury_in],
    outputs: [treasury_out, group_output, test_borrower_output()],
    validity_range: interval.after(0),
  }

  // list.find_map returns None → expect Some(borrower_cred) crashes
  validate_distribute_treasury(
    tp,
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    wrong_slot_datum,
    treasury_utxo_ref(),
    tx,
  )
}

// Duplicate output indices: [0, 0] not strictly ascending — indices_in_ascending_order fails
test distribute_round__rejects_duplicate_output_index() {
  let (tx, datum, utxo) = setup_distribute_round()
  !validate_distribute_treasury(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    [1],
    [0, 0],
    2,
    datum,
    utxo,
    tx,
  )
}

// rounds_paid != round_number — member_at_correct_round fails.
// round_number=1, current_slot=1%3=1 → treasury input must have assigned_slot=1 so
// the borrower search doesn't crash before member_at_correct_round is checked.
test distribute_round__rejects_wrong_round_number() {
  let tp = treasury_policy()
  let gp = group_policy()

  // Group: round 0 already done (last_distributed_round=0), now distributing round 1
  let group_datum = GroupDatum {
    ..test_group_datum(),
    num_rounds: 3,
    is_started: True,
    last_distributed_round: 0,
  }
  let group_in_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: group_in_value,
      datum: InlineDatum(cip68_with_group(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: group_in_value,
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum, last_distributed_round: 1 }),
    ),
    reference_script: None,
  }

  // Treasury input: assigned_slot=1 (matches current_slot=1%3=1), rounds_paid=0 (wrong for round_number=1)
  let datum = build_treasury_state(1, group_ref_tn(), 0)
  let treasury_in_value = treasury_value()
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, treasury_in_value),
  )

  // Treasury output: rounds_paid=2, ADA reduced (validator will return False before checking this)
  let updated_datum = build_treasury_state(1, group_ref_tn(), 2)
  let treasury_out = test_treasury_output(
    updated_datum,
    assets.from_lovelace(3_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1)),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, treasury_in],
    outputs: [treasury_out, group_output, test_borrower_output()],
    validity_range: interval.after(0),
  }

  // round_number=1 but rounds_paid=0 → member_at_correct_round = False → returns False
  !validate_distribute_treasury(
    tp,
    group_policy(),
    1,
    0,
    1,
    [1],
    [0],
    2,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// Group output has stale last_distributed_round (-1 instead of 0) — group_round_incremented fails
test distribute_round__rejects_unchanged_group_round() {
  let tp = treasury_policy()
  let (tx, datum, utxo) = setup_distribute_round()

  let Transaction { inputs, outputs, validity_range, .. } = tx
  expect Some(treasury_out) = list.at(outputs, 0)
  expect Some(old_group_out) = list.at(outputs, 1)
  expect Some(borrower_out) = list.at(outputs, 2)
  expect InlineDatum(gd_data) = old_group_out.datum
  expect GroupCip68Datum { extra: gd, .. } = gd_data
  // Replace group output with stale last_distributed_round = -1
  let stale_group_out = Output {
    ..old_group_out,
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..gd, last_distributed_round: -1 }),
    ),
  }

  let bad_tx = Transaction {
    ..transaction.placeholder,
    inputs,
    outputs: [treasury_out, stale_group_out, borrower_out],
    validity_range,
  }

  !validate_distribute_treasury(
    tp,
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    datum,
    utxo,
    bad_tx,
  )
}

// --- Pull payout mode (earmark into borrower's own treasury) ---

// Single-member Pull round. The lone member (slot 0) is the borrower for round 0, so the
// pot (total_payout = 1 × 2M) is earmarked into their OWN treasury output via
// claimable_balance, NOT paid to a wallet. Caller supplies the treasury output so negative
// tests can perturb it. There is deliberately no borrower wallet output.
fn pull_distribute_tx(
  treasury_out: Output,
) -> (Transaction, TreasuryDatum, OutputReference) {
  let gp = group_policy()

  let group_datum = GroupDatum {
    ..test_group_datum(),
    num_rounds: 3,
    is_started: True,
    last_distributed_round: -1,
    member_token_names: [member_tn()],
    payout_mode: Pull,
  }
  let group_in_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: group_in_value,
      datum: InlineDatum(cip68_with_group(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: group_in_value,
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum, last_distributed_round: 0 }),
    ),
    reference_script: None,
  }

  // Treasury input: slot 0, round 0, claimable 0, holding 5M ADA + membership token.
  let treasury_datum = build_treasury_state(0, group_ref_tn(), 0)
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(
    utxo_ref,
    test_treasury_output(treasury_datum, treasury_value()),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, treasury_in],
    outputs: [treasury_out, group_output],
    validity_range: interval.after(0),
  }

  (tx, treasury_datum, utxo_ref)
}

// Correct Pull output: balance net unchanged (5M − 2M fee + 2M payout) and claimable += 2M.
fn pull_earmark_datum(claimable: Int) -> TreasuryDatum {
  TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    assigned_slot: 0,
    rounds_paid: 1,
    member_payment_credential: common.test_pkh(),
    claimable_balance: claimable,
  }
}

// Pull: borrower's own treasury accrues the pot (claimable += total_payout); no wallet output.
test distribute_round__pull_accepts_earmark() {
  let out = test_treasury_output(
    pull_earmark_datum(2_000_000),
    treasury_value(),
  )
  let (tx, datum, utxo) = pull_distribute_tx(out)
  // borrower_output_index is irrelevant under Pull (pass 0).
  validate_distribute_treasury(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    0,
    datum,
    utxo,
    tx,
  )
}

// Pull: rejected if the earmark is missing (claimable not credited).
test distribute_round__pull_rejects_missing_earmark() {
  let out = test_treasury_output(pull_earmark_datum(0), treasury_value())
  let (tx, datum, utxo) = pull_distribute_tx(out)
  !validate_distribute_treasury(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    0,
    datum,
    utxo,
    tx,
  )
}

// Pull: rejected if the pot value is not credited into the treasury (balance only -fee,
// Push-style 3M instead of the net-unchanged 5M the earmark requires).
test distribute_round__pull_rejects_value_not_credited() {
  let short_value = assets.from_lovelace(3_000_000)
    |> assets.merge(assets.from_asset(treasury_policy(), member_tn(), 1))
  let out = test_treasury_output(pull_earmark_datum(2_000_000), short_value)
  let (tx, datum, utxo) = pull_distribute_tx(out)
  !validate_distribute_treasury(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    0,
    datum,
    utxo,
    tx,
  )
}

// --- Token-group ADA-reserve conservation (permissionless-skim guard) ---

// Single-member Pull round on a NATIVE-TOKEN group. The lone member (slot 0) is the
// borrower, so the pot (1 × 1000 tokens) is earmarked into their own treasury via
// claimable_balance — the contribution asset is a token, so the -fee balance check
// measures the TOKEN and the UTxO's lovelace is governed only by ada_reserve_conserved.
// Caller supplies the treasury output so the skim negative can drain its lovelace.
fn token_pull_distribute_tx(
  treasury_out: Output,
) -> (Transaction, TreasuryDatum, OutputReference) {
  let gp = group_policy()
  let group_datum = GroupDatum {
    ..token_group_datum(),
    num_rounds: 3,
    is_started: True,
    last_distributed_round: -1,
    member_token_names: [member_tn()],
    payout_mode: Pull,
  }
  let group_in_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address { payment_credential: Script(gp), stake_credential: None },
      value: group_in_value,
      datum: InlineDatum(cip68_with_group(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: group_in_value,
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum, last_distributed_round: 0 }),
    ),
    reference_script: None,
  }
  // Treasury input: slot 0, round 0, claimable 0, holding 2M ADA reserve + 2000 tokens.
  let treasury_datum = build_treasury_state(0, group_ref_tn(), 0)
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(
    utxo_ref,
    test_treasury_output(treasury_datum, token_treasury_value(2000)),
  )
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, treasury_in],
    outputs: [treasury_out, group_output],
    validity_range: interval.after(0),
  }
  (tx, treasury_datum, utxo_ref)
}

// Correct Pull earmark on the token group: token balance net unchanged
// (2000 − 1000 fee + 1000 payout) and claimable += 1000.
fn token_pull_earmark_datum() -> TreasuryDatum {
  TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    assigned_slot: 0,
    rounds_paid: 1,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 1000,
  }
}

// Token group: a round that keeps the full 2M ADA reserve is accepted. (Positive control
// proving ada_reserve_conserved is not over-tight — only a *decrease* is rejected.)
test distribute_round__token_group_accepts_conserved_ada() {
  let out = test_treasury_output(
    token_pull_earmark_datum(),
    token_treasury_value(2000),
  )
  let (tx, datum, utxo) = token_pull_distribute_tx(out)
  validate_distribute_treasury(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    0,
    datum,
    utxo,
    tx,
  )
}

// Token group: the cranker routes 600k of the member's 2M ADA reserve into their own
// change. The contribution TOKEN is still conserved (2000 unchanged) and the earmark is
// correct, so EVERY other check passes — only ada_reserve_conserved catches the skim.
// Pre-fix this returned True (the lovelace was unpinned); the guard now rejects it.
test distribute_round__token_group_rejects_ada_skim() {
  let skim_value = assets.from_lovelace(1_400_000)
    |> assets.merge(assets.from_asset(treasury_policy(), member_tn(), 1))
    |> assets.merge(assets.from_asset(token_policy(), token_name(), 2000))
  let out = test_treasury_output(token_pull_earmark_datum(), skim_value)
  let (tx, datum, utxo) = token_pull_distribute_tx(out)
  !validate_distribute_treasury(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    0,
    datum,
    utxo,
    tx,
  )
}

// --- Pro-rata distribution (complete member set) ---

fn member_b_tn() -> assets.AssetName {
  #"bbccddeebbccddeebbccddeebbccddeebbccddeebbccddeebbccddee"
}

// A 2-member round. Member A (slot 0) contributes and is the borrower. Member B holds
// `member_b_tn()` and carries `b_datum`, placed as a reference input when `b_as_reference`
// is True (defaulter path) or as a spending input otherwise.
fn two_member_distribute(
  b_datum: TreasuryDatum,
  b_as_reference: Bool,
) -> (Transaction, TreasuryDatum, OutputReference) {
  let tp = treasury_policy()
  let gp = group_policy()

  let group_datum = GroupDatum {
    ..test_group_datum(),
    num_rounds: 3,
    is_started: True,
    last_distributed_round: -1,
    member_token_names: [member_tn(), member_b_tn()],
  }
  let group_in_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: group_in_value,
      datum: InlineDatum(cip68_with_group(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: group_in_value,
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum, last_distributed_round: 0 }),
    ),
    reference_script: None,
  }

  // Member A — contributing borrower at slot 0.
  let a_datum = build_treasury_state(0, group_ref_tn(), 0)
  let utxo_ref = treasury_utxo_ref()
  let a_in = test_treasury_input(
    utxo_ref,
    test_treasury_output(a_datum, treasury_value()),
  )
  let a_out = test_treasury_output(
    build_treasury_state(0, group_ref_tn(), 1),
    assets.from_lovelace(min_ada_reserve + 3_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1)),
  )

  // Member B — value holds member_b_tn(); classification is by datum constructor.
  let b_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(tp, member_b_tn(), 1))
  let b_io = Input {
    output_reference: OutputReference {
      transaction_id: #"4444444444444444444444444444444444444444444444444444444444444444",
      output_index: 0,
    },
    output: test_treasury_output(b_datum, b_value),
  }

  let tx = if b_as_reference {
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, a_in],
      reference_inputs: [b_io],
      outputs: [a_out, group_output, test_borrower_output()],
      validity_range: interval.after(0),
    }
  } else {
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, a_in, b_io],
      outputs: [a_out, group_output, test_borrower_output()],
      validity_range: interval.after(0),
    }
  }
  (tx, a_datum, utxo_ref)
}

// Pro-rata: B has defaulted (DefaultState) and is a reference input. active_members = 1,
// so the borrower receives 1 × contribution_fee (2M) — the reduced pot — and the round
// still completes rather than stalling.
test distribute_round__accepts_prorata_with_defaulter() {
  let (tx, datum, utxo) = two_member_distribute(
    test_insufficient_collateral_state(),
    True,
  )
  validate_distribute_treasury(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    datum,
    utxo,
    tx,
  )
}

// Completeness: a member listed in member_token_names is neither spent nor referenced →
// the round cannot advance (count_active_members fails to find member B anywhere).
test distribute_round__rejects_excluded_member() fail {
  let tp = treasury_policy()
  let gp = group_policy()

  let group_datum = GroupDatum {
    ..test_group_datum(),
    num_rounds: 3,
    is_started: True,
    last_distributed_round: -1,
    member_token_names: [member_tn(), member_b_tn()],
  }
  let group_in_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: group_in_value,
      datum: InlineDatum(cip68_with_group(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: group_in_value,
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..group_datum, last_distributed_round: 0 }),
    ),
    reference_script: None,
  }
  let a_datum = build_treasury_state(0, group_ref_tn(), 0)
  let utxo_ref = treasury_utxo_ref()
  let a_in = test_treasury_input(
    utxo_ref,
    test_treasury_output(a_datum, treasury_value()),
  )
  let a_out = test_treasury_output(
    build_treasury_state(0, group_ref_tn(), 1),
    assets.from_lovelace(3_000_000)
      |> assets.merge(assets.from_asset(tp, member_tn(), 1)),
  )
  // Member B is absent from both inputs and reference_inputs.
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, a_in],
    outputs: [a_out, group_output, test_borrower_output()],
    validity_range: interval.after(0),
  }
  validate_distribute_treasury(
    tp,
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    a_datum,
    utxo_ref,
    tx,
  )
}

// Anti-dodge: a healthy member (TreasuryState) cannot be parked as a reference input to
// avoid contributing — count_active_members rejects a TreasuryState found in references.
test distribute_round__rejects_healthy_member_referenced() fail {
  let (tx, datum, utxo) = two_member_distribute(
    build_treasury_state(1, group_ref_tn(), 0),
    True,
  )
  validate_distribute_treasury(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    [1],
    [0],
    2,
    datum,
    utxo,
    tx,
  )
}

// ─── validate_exit_group ──────────────────────────────────────────────────────

// Early exit: group is_active && current_time < maturity (0 + 3*1000 = 3000)
// Penalty output holds ≥ penalty_fee; member_count decrements immediately.
test exit_group__accepts_early_exit_with_penalty() {
  let tp = treasury_policy()
  let gp = group_policy()

  let current_time = 1500
  let active_group_datum = GroupDatum { ..test_group_datum(), member_count: 1 }
  let group_input = Input {
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
      datum: InlineDatum(cip68_with_group(active_group_datum)),
      reference_script: None,
    },
  }
  let member_input = test_member_input()

  let datum = test_treasury_state(0)

  let penalty_datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }
  // 500K contributable meets the penalty_fee floor; reserve carries the membership token.
  let penalty_value = assets.from_lovelace(min_ada_reserve + 500_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let penalty_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value: penalty_value,
    datum: InlineDatum(penalty_datum),
    reference_script: None,
  }

  // Group output: member_count 1 → 0 (slot freed immediately)
  let group_out = test_group_output(0)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [penalty_output, group_out],
    validity_range: interval.after(current_time),
  }

  validate_exit_treasury(
    tp,
    account_policy(),
    group_policy(),
    0,
    1,
    1,
    0,
    datum,
    tx,
  )
}

// Mature exit: group is_active=False → burn path
test exit_group__accepts_mature_exit_with_burn() {
  let tp = treasury_policy()

  let inactive_group_datum = GroupDatum {
    ..test_group_datum(),
    is_active: False,
    member_count: 1,
  }
  let gp = group_policy()
  let group_input = Input {
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
      datum: InlineDatum(cip68_with_group(inactive_group_datum)),
      reference_script: None,
    },
  }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)

  let mint = assets.from_asset(tp, member_tn(), -1)

  let group_out = test_group_output(0)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [group_out],
    mint,
    validity_range: interval.after(500),
  }

  validate_exit_treasury(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    1,
    0,
    datum,
    tx,
  )
}

// fail: expect TreasuryState crashes when datum is PenaltyState
test exit_group__rejects_penalty_state_datum() fail {
  let tp = treasury_policy()

  let current_time = 1500
  let group_input = test_group_input()
  let member_input = test_member_input()

  let penalty_datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }

  let group_out = test_group_output(0)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [group_out],
    validity_range: interval.after(current_time),
  }

  validate_exit_treasury(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    1,
    0,
    penalty_datum,
    tx,
  )
}

// Member input holds no token matching member_reference_tokenname → member_authorized fails
test exit_group__rejects_member_input_without_user_token() {
  let tp = treasury_policy()

  let current_time = 1500
  let group_input = test_group_input_with_member_count(1)

  let no_token_input = Input {
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

  let penalty_datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }
  // 500K contributable meets the penalty_fee floor; reserve carries the membership token.
  let penalty_value = assets.from_lovelace(min_ada_reserve + 500_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let penalty_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value: penalty_value,
    datum: InlineDatum(penalty_datum),
    reference_script: None,
  }

  let group_out = test_group_output(0)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, no_token_input],
    outputs: [penalty_output, group_out],
    validity_range: interval.after(current_time),
  }

  !validate_exit_treasury(
    tp,
    account_policy(),
    group_policy(),
    0,
    1,
    1,
    0,
    datum,
    tx,
  )
}

// Mature exit path: group inactive but no burn — token_burned fails
test exit_group__rejects_mature_exit_without_burn() {
  let tp = treasury_policy()

  let inactive_group_datum = GroupDatum {
    ..test_group_datum(),
    is_active: False,
    member_count: 1,
  }
  let gp = group_policy()
  let group_input = Input {
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
      datum: InlineDatum(cip68_with_group(inactive_group_datum)),
      reference_script: None,
    },
  }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)

  let group_out = test_group_output(0)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [group_out],
    mint: assets.zero,
    validity_range: interval.after(500),
  }

  !validate_exit_treasury(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    1,
    0,
    datum,
    tx,
  )
}

test exit_group__rejects_early_exit_missing_penalty_fee() {
  let tp = treasury_policy()

  let current_time = 1500
  let group_input = test_group_input_with_member_count(1)
  let member_input = test_member_input()

  let datum = test_treasury_state(0)

  let penalty_datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }
  // Penalty output with NO ADA — penalty_fee_locked (500K required) fails
  let penalty_value = assets.from_asset(tp, member_tn(), 1)
  let penalty_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value: penalty_value,
    datum: InlineDatum(penalty_datum),
    reference_script: None,
  }

  let group_out = test_group_output(0)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [penalty_output, group_out],
    validity_range: interval.after(current_time),
  }

  !validate_exit_treasury(
    tp,
    account_policy(),
    group_policy(),
    0,
    1,
    1,
    0,
    datum,
    tx,
  )
}

// Penalty output holds exactly penalty_fee — member reclaims the rest as change
test exit_group__accepts_member_reclaims_refund() {
  let tp = treasury_policy()

  let current_time = 1500
  let group_input = test_group_input_with_member_count(1)
  let member_input = test_member_input()
  let datum = test_treasury_state(0)

  let penalty_datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }
  // 500K contributable meets the penalty_fee floor; reserve carries the membership token.
  let penalty_value = assets.from_lovelace(min_ada_reserve + 500_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let penalty_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value: penalty_value,
    datum: InlineDatum(penalty_datum),
    reference_script: None,
  }

  let group_out = test_group_output(0)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [penalty_output, group_out],
    validity_range: interval.after(current_time),
  }

  validate_exit_treasury(
    tp,
    account_policy(),
    group_policy(),
    0,
    1,
    1,
    0,
    datum,
    tx,
  )
}

// Pre-cycle exit: current_time < start_time → free exit (token burned, no penalty)
test exit_group__accepts_pre_cycle_exit_without_penalty() {
  let tp = treasury_policy()
  let gp = group_policy()

  let future_start = 5000
  let pre_cycle_group_datum = GroupDatum {
    ..test_group_datum(),
    member_count: 1,
    start_time: future_start,
  }
  let group_input = Input {
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
      datum: InlineDatum(cip68_with_group(pre_cycle_group_datum)),
      reference_script: None,
    },
  }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)

  let mint = assets.from_asset(tp, member_tn(), -1)

  let group_out = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
    datum: InlineDatum(
      cip68_with_group(GroupDatum { ..pre_cycle_group_datum, member_count: 0 }),
    ),
    reference_script: None,
  }

  // current_time = 1500 < start_time = 5000 → is_early_exit = False → burn path
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [group_out],
    mint,
    validity_range: interval.after(1500),
  }

  validate_exit_treasury(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    1,
    0,
    datum,
    tx,
  )
}

// In-cycle burn attempt: is_early_exit = True but no penalty output — expect PenaltyState crashes
test exit_group__rejects_in_cycle_burn_without_penalty() fail {
  let tp = treasury_policy()
  let gp = group_policy()

  let current_time = 1500
  let active_group_datum = GroupDatum { ..test_group_datum(), member_count: 1 }
  let group_input = Input {
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
      datum: InlineDatum(cip68_with_group(active_group_datum)),
      reference_script: None,
    },
  }

  let member_input = test_member_input()
  let datum = test_treasury_state(0)

  let mint = assets.from_asset(tp, member_tn(), -1)

  // Group output at index 0 — penalty_output_index also 0 → expect PenaltyState crashes
  let group_out = test_group_output(0)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [group_out],
    mint,
    validity_range: interval.after(current_time),
  }

  validate_exit_treasury(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    1,
    0,
    datum,
    tx,
  )
}

// In-cycle early exit: group output member_count not decremented — group_count_decremented fails
test exit_group__rejects_early_exit_without_group_count_decrement() {
  let tp = treasury_policy()

  let current_time = 1500
  let group_input = test_group_input_with_member_count(1)
  let member_input = test_member_input()
  let datum = test_treasury_state(0)

  let penalty_datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }
  // 500K contributable meets the penalty_fee floor; reserve carries the membership token.
  let penalty_value = assets.from_lovelace(min_ada_reserve + 500_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let penalty_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value: penalty_value,
    datum: InlineDatum(penalty_datum),
    reference_script: None,
  }

  // Group output: member_count stays at 1 — not decremented
  let group_out = test_group_output(1)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [penalty_output, group_out],
    validity_range: interval.after(current_time),
  }

  !validate_exit_treasury(
    tp,
    account_policy(),
    group_policy(),
    0,
    1,
    1,
    0,
    datum,
    tx,
  )
}

// ExitGroup: treasury datum's group_reference_tokenname mismatches actual group input
test exit_group__rejects_wrong_group_link() {
  let tp = treasury_policy()

  let inactive_group_datum = GroupDatum {
    ..test_group_datum(),
    is_active: False,
    member_count: 1,
  }
  let gp = group_policy()
  let group_input = Input {
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
      datum: InlineDatum(cip68_with_group(inactive_group_datum)),
      reference_script: None,
    },
  }

  let member_input = test_member_input()

  // Datum uses a WRONG group_reference_tokenname — simulates a cross-group attack
  let wrong_datum = build_treasury_state(
    0,
    #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    0,
  )

  let mint = assets.from_asset(tp, member_tn(), -1)
  let group_out = test_group_output(0)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, member_input],
    outputs: [group_out],
    mint,
    validity_range: interval.after(500),
  }

  !validate_exit_treasury(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    1,
    0,
    wrong_datum,
    tx,
  )
}

// ─── validate_claim_penalty ──────────────────────────────────────────

test spend_terminate_group__accepts_penalty_burn() {
  let tp = treasury_policy()
  let datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }
  let mint = assets.from_asset(tp, member_tn(), -1)
  validate_claim_penalty(
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
  validate_claim_penalty(
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
  let datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }
  let mint = assets.zero
  !validate_claim_penalty(
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
  let datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }
  let wrong_tn = #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  let mint = assets.from_asset(tp, wrong_tn, -1)
  !validate_claim_penalty(
    tp,
    datum,
    group_policy(),
    0,
    [test_admin_input()],
    mint,
  )
}

test spend_terminate_group__rejects_no_admin_token() {
  let tp = treasury_policy()
  let datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }
  let no_token_admin_input = Input {
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
  !validate_claim_penalty(
    tp,
    datum,
    group_policy(),
    0,
    [no_token_admin_input],
    mint,
  )
}

// ─── validate_contribute ──────────────────────────────────────────────────────

// Member tops up their contributable balance from 5M to 7M (reserve retained on top)
test contribute__accepts_valid_top_up() {
  let tp = treasury_policy()

  let datum = test_treasury_state(0)
  let in_value = treasury_value()
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let member_input = test_member_input()

  let out_value = assets.from_lovelace(min_ada_reserve + 7_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_out = test_treasury_output(datum, out_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [member_input, treasury_in],
    reference_inputs: [test_group_input()],
    outputs: [treasury_out],
  }

  // group_ref_input_index=0, member_input_index=0, treasury_output_index=0
  validate_contribute(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// [security C1] Identical to the accept above EXCEPT the group reference input is the
// attacker's forged group at a fake script → the trusted-binding assertion rejects it.
test contribute__rejects_fake_group_script() fail {
  let tp = treasury_policy()

  let datum = test_treasury_state(0)
  let in_value = treasury_value()
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let member_input = test_member_input()

  let out_value = assets.from_lovelace(7_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_out = test_treasury_output(datum, out_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [member_input, treasury_in],
    reference_inputs: [fake_group_input()],
    outputs: [treasury_out],
  }

  validate_contribute(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// fail: expect TreasuryState crashes when datum is PenaltyState
test contribute__rejects_penalty_state() fail {
  let tp = treasury_policy()

  let datum = PenaltyState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
  }
  let in_value = treasury_value()
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let member_input = test_member_input()
  let out_value = assets.from_lovelace(7_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let treasury_out = test_treasury_output(datum, out_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [member_input, treasury_in],
    reference_inputs: [test_group_input()],
    outputs: [treasury_out],
  }

  validate_contribute(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// ADA stays same — balance_increased (output > input) fails
test contribute__rejects_no_ada_increase() {
  let tp = treasury_policy()

  let datum = test_treasury_state(0)
  let in_value = treasury_value()
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let member_input = test_member_input()

  // Output balance == input balance — not increased
  let out_value = treasury_value()
  let treasury_out = test_treasury_output(datum, out_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [member_input, treasury_in],
    reference_inputs: [test_group_input()],
    outputs: [treasury_out],
  }

  !validate_contribute(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// Output datum has modified assigned_slot — datum_unchanged fails
test contribute__rejects_datum_changed() {
  let tp = treasury_policy()

  let datum = test_treasury_state(0)
  let in_value = treasury_value()
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let member_input = test_member_input()

  let out_value = assets.from_lovelace(7_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  // Changed assigned_slot: 0 → 1
  let modified_datum = build_treasury_state(1, group_ref_tn(), 0)
  let treasury_out = test_treasury_output(modified_datum, out_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [member_input, treasury_in],
    reference_inputs: [test_group_input()],
    outputs: [treasury_out],
  }

  !validate_contribute(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// --- Native-token support ---

// Member tops up a NATIVE-TOKEN treasury: token balance 1000 → 2000.
test contribute__accepts_native_token_top_up() {
  let tp = treasury_policy()

  let datum = test_treasury_state(0)
  let in_value = token_treasury_value(1000)
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let member_input = test_member_input()

  let out_value = token_treasury_value(2000)
  let treasury_out = test_treasury_output(datum, out_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [member_input, treasury_in],
    reference_inputs: [token_group_input()],
    outputs: [treasury_out],
  }

  validate_contribute(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// DefaultState recovery is REJECTED when the topped-up token balance is below
// contribution_fee (500 < 1000) — closes the "+1 unit recovery" gap.
test contribute__rejects_default_recovery_below_fee() {
  let tp = treasury_policy()

  let datum = test_insufficient_collateral_state()
  let in_value = token_treasury_value(0)
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let member_input = test_member_input()

  let out_value = token_treasury_value(500)
  let out_datum = build_treasury_state(0, group_ref_tn(), 0)
  let treasury_out = test_treasury_output(out_datum, out_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [member_input, treasury_in],
    reference_inputs: [token_group_input()],
    outputs: [treasury_out],
  }

  !validate_contribute(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// DefaultState recovery is ACCEPTED when the topped-up token balance reaches
// contribution_fee (1000 == 1000).
test contribute__accepts_default_recovery_at_fee() {
  let tp = treasury_policy()

  let datum = test_insufficient_collateral_state()
  let in_value = token_treasury_value(0)
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let member_input = test_member_input()

  let out_value = token_treasury_value(1000)
  let out_datum = build_treasury_state(0, group_ref_tn(), 0)
  let treasury_out = test_treasury_output(out_datum, out_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [member_input, treasury_in],
    reference_inputs: [token_group_input()],
    outputs: [treasury_out],
  }

  validate_contribute(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// [P4] DefaultState recovery carries the Pull earmark (claimable_balance) back into
// TreasuryState. A member who defaulted while holding an unclaimed earmark keeps it on
// recovery and can still ClaimPayout it. (The earmarked funds were always in the UTxO
// value; this preserves the claim marker too.)
test contribute__recovery_carries_claimable_balance() {
  let tp = treasury_policy()

  let datum = DefaultState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    grace_expires_at: 5000,
    grace_extensions_used: 0,
    rounds_paid: 0,
    assigned_slot: 0,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 2000,
  }
  let in_value = token_treasury_value(0)
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let member_input = test_member_input()

  // Output: recovered TreasuryState reconstructing the carried earmark (2000).
  let out_value = token_treasury_value(3000)
  let out_datum = TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    assigned_slot: 0,
    rounds_paid: 0,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 2000,
  }
  let treasury_out = test_treasury_output(out_datum, out_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [member_input, treasury_in],
    reference_inputs: [token_group_input()],
    outputs: [treasury_out],
  }

  validate_contribute(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// [P4] Recovery that DROPS the carried earmark (claimable 2000 → 0) is REJECTED — the
// output TreasuryState must reconstruct claimable_balance faithfully (no silent forfeit).
test contribute__rejects_recovery_dropping_claimable() {
  let tp = treasury_policy()

  let datum = DefaultState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    grace_expires_at: 5000,
    grace_extensions_used: 0,
    rounds_paid: 0,
    assigned_slot: 0,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 2000,
  }
  let in_value = token_treasury_value(0)
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let member_input = test_member_input()

  // Output zeroes the earmark — the old buggy behavior; must be rejected.
  let out_value = token_treasury_value(3000)
  let out_datum = build_treasury_state(0, group_ref_tn(), 0)
  let treasury_out = test_treasury_output(out_datum, out_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [member_input, treasury_in],
    reference_inputs: [token_group_input()],
    outputs: [treasury_out],
  }

  !validate_contribute(
    tp,
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// ─── validate_update_payout_credential ───────────────────────────────────────

// Member updates payout credential — output datum has new member_payment_credential
test update_payout_credential__accepts_valid_update() {
  let tp = treasury_policy()

  let datum = test_treasury_state(0)
  let in_value = treasury_value()
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let member_input = test_member_input()

  // Output datum: member_payment_credential updated to common.test_pkh() (member input's pkh).
  // test_member_input() is at VerificationKey(common.test_pkh()), so new_pkh = test_pkh().
  // Since build_treasury_state already sets member_payment_credential = test_pkh(), this is unchanged
  // but the validator still exercises the auth and datum-check paths.
  let expected_datum = TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    assigned_slot: 0,
    rounds_paid: 0,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 0,
  }
  let treasury_out = test_treasury_output(expected_datum, in_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [member_input, treasury_in],
    outputs: [treasury_out],
  }

  validate_update_payout(
    tp,
    account_policy(),
    0,
    // member_input_index
    0,
    // treasury_output_index
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// Member input lacks account NFT — member_authorized fails
test update_payout_credential__rejects_no_member_token() {
  let tp = treasury_policy()

  let datum = test_treasury_state(0)
  let in_value = treasury_value()
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )

  // Wallet-only input: no account user token
  let no_token_input = Input {
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

  let expected_datum = TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    assigned_slot: 0,
    rounds_paid: 0,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 0,
  }
  let treasury_out = test_treasury_output(expected_datum, in_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [no_token_input, treasury_in],
    outputs: [treasury_out],
  }

  !validate_update_payout(
    tp,
    account_policy(),
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// ─── validate_extend_grace_window ─────────────────────────────────────────────

// Admin extends grace window — grace_expires_at + grace_period_length, grace_extensions_used + 1
test extend_grace_window__accepts_valid_extension() {
  let tp = treasury_policy()

  // datum: grace_expires_at=5000, grace_extensions_used=0
  let datum = test_insufficient_collateral_state()
  let in_value = treasury_value()
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let admin_input = test_admin_input()

  // Expected output: grace_expires_at = 5000 + 1000 (grace_period_length), extensions = 1
  let expected_datum = DefaultState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    grace_expires_at: 6000,
    grace_extensions_used: 1,
    rounds_paid: 0,
    assigned_slot: 0,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 0,
  }
  let treasury_out = test_treasury_output(expected_datum, in_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [admin_input, treasury_in],
    outputs: [treasury_out],
  }

  // grace_period_length = 1000 (passed from entry point reading group datum)
  validate_extend_grace(
    tp,
    group_policy(),
    1000,
    // grace_period_length
    0,
    // admin_input_index
    0,
    // treasury_output_index
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// grace_extensions_used == max_grace_extensions — extensions_available fails
test extend_grace_window__rejects_max_extensions_reached() {
  let tp = treasury_policy()

  // grace_extensions_used already at maximum
  let datum = DefaultState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    grace_expires_at: 5000,
    grace_extensions_used: max_grace_extensions,
    rounds_paid: 0,
    assigned_slot: 0,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 0,
  }
  let in_value = treasury_value()
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )
  let admin_input = test_admin_input()

  let expected_datum = DefaultState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    grace_expires_at: 6000,
    grace_extensions_used: max_grace_extensions + 1,
    rounds_paid: 0,
    assigned_slot: 0,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 0,
  }
  let treasury_out = test_treasury_output(expected_datum, in_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [admin_input, treasury_in],
    outputs: [treasury_out],
  }

  !validate_extend_grace(
    tp,
    group_policy(),
    1000,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// Admin input lacks the group (222) token — admin_authorized fails
test extend_grace_window__rejects_no_admin_token() {
  let tp = treasury_policy()

  let datum = test_insufficient_collateral_state()
  let in_value = treasury_value()
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, in_value),
  )

  // Admin input holds only ADA — no group admin token
  let no_token_admin = Input {
    output_reference: OutputReference {
      transaction_id: #"4444444444444444444444444444444444444444444444444444444444444444",
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

  let expected_datum = DefaultState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    grace_expires_at: 6000,
    grace_extensions_used: 1,
    rounds_paid: 0,
    assigned_slot: 0,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 0,
  }
  let treasury_out = test_treasury_output(expected_datum, in_value)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [no_token_admin, treasury_in],
    outputs: [treasury_out],
  }

  !validate_extend_grace(
    tp,
    group_policy(),
    1000,
    0,
    0,
    datum,
    treasury_utxo_ref(),
    tx,
  )
}

// ─── ClaimPayout (Pull withdrawal) ────────────────────────────────────────────

// Treasury holding 5M collateral + a 2M earmark (claimable_balance) + membership token.
// The group is a reference input (contribution asset identity + link). Caller supplies the
// continuation output so negative tests can perturb the datum / value.
fn claim_payout_setup(
  out_datum: TreasuryDatum,
  out_value: assets.Value,
) -> (Transaction, TreasuryDatum, OutputReference) {
  let tp = treasury_policy()
  let gp = group_policy()

  let group_ref = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(cip68_with_group(test_group_datum())),
      reference_script: None,
    },
  }

  // 7M lovelace = 5M collateral + 2M earmark; claimable_balance = 2M.
  let in_datum = TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    assigned_slot: 0,
    rounds_paid: 1,
    member_payment_credential: common.test_pkh(),
    claimable_balance: 2_000_000,
  }
  let in_value = assets.from_lovelace(7_000_000)
    |> assets.merge(assets.from_asset(tp, member_tn(), 1))
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(
    utxo_ref,
    test_treasury_output(in_datum, in_value),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [treasury_in, test_member_input()],
    reference_inputs: [group_ref],
    outputs: [test_treasury_output(out_datum, out_value)],
  }
  (tx, in_datum, utxo_ref)
}

fn claim_payout_out_datum(claimable: Int) -> TreasuryDatum {
  TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: member_tn(),
    assigned_slot: 0,
    rounds_paid: 1,
    member_payment_credential: common.test_pkh(),
    claimable_balance: claimable,
  }
}

fn claim_payout_value(lovelace: Int) -> assets.Value {
  assets.from_lovelace(lovelace)
    |> assets.merge(assets.from_asset(treasury_policy(), member_tn(), 1))
}

// Member pulls exactly the earmark to their wallet; collateral (5M) stays, claimable -> 0.
test claim_payout__accepts_valid_claim() {
  let out = claim_payout_value(5_000_000)
  let (tx, datum, utxo) = claim_payout_setup(claim_payout_out_datum(0), out)
  validate_claim_payout(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    1,
    0,
    datum,
    utxo,
    tx,
  )
}

// Rejected without the member (222) token -- member_input points at the treasury input.
test claim_payout__rejects_no_member_token() {
  let out = claim_payout_value(5_000_000)
  let (tx, datum, utxo) = claim_payout_setup(claim_payout_out_datum(0), out)
  !validate_claim_payout(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    datum,
    utxo,
    tx,
  )
}

// Rejected if claimable_balance is not reset to 0 (would allow a double-claim).
test claim_payout__rejects_claimable_not_reset() {
  let out = claim_payout_value(5_000_000)
  let (tx, datum, utxo) = claim_payout_setup(
    claim_payout_out_datum(2_000_000),
    out,
  )
  !validate_claim_payout(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    1,
    0,
    datum,
    utxo,
    tx,
  )
}

// Rejected if more than the earmark leaves (collateral drained: output 4M, not 5M).
test claim_payout__rejects_over_withdrawal() {
  let out = claim_payout_value(4_000_000)
  let (tx, datum, utxo) = claim_payout_setup(claim_payout_out_datum(0), out)
  !validate_claim_payout(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    1,
    0,
    datum,
    utxo,
    tx,
  )
}

// ─── NextCycle (cycle reset + M2 re-funding guard) ────────────────────────────

// A completed 2-round cycle being reset. The member's treasury (rounds_paid == num_rounds)
// resets to rounds_paid 0; the group flips is_started -> False, last_distributed_round -> -1.
// Caller supplies the treasury value so the re-funding guard can be exercised.
fn next_cycle_setup(
  treasury_val: assets.Value,
) -> (Transaction, TreasuryDatum, OutputReference) {
  let gp = group_policy()

  let group_datum = GroupDatum {
    ..test_group_datum(),
    num_rounds: 2,
    is_started: True,
    last_distributed_round: 1,
    member_token_names: [member_tn()],
  }
  let group_in_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let group_input = Input {
    output_reference: OutputReference {
      transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: group_in_value,
      datum: InlineDatum(cip68_with_group(group_datum)),
      reference_script: None,
    },
  }
  let group_output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: group_in_value,
    datum: InlineDatum(
      cip68_with_group(
        GroupDatum {
          ..group_datum,
          is_started: False,
          last_distributed_round: -1,
        },
      ),
    ),
    reference_script: None,
  }

  // Treasury input: cycle complete (rounds_paid == num_rounds == 2).
  let in_datum = build_treasury_state(0, group_ref_tn(), 2)
  let utxo_ref = treasury_utxo_ref()
  let treasury_in = test_treasury_input(
    utxo_ref,
    test_treasury_output(in_datum, treasury_val),
  )
  // Output: counters reset; value preserved.
  let out_datum = build_treasury_state(0, group_ref_tn(), 0)
  let treasury_out = test_treasury_output(out_datum, treasury_val)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [group_input, treasury_in],
    outputs: [treasury_out, group_output],
  }
  (tx, in_datum, utxo_ref)
}

// Re-funded member (5M >= floor 2M) resets into the new cycle.
test next_cycle__accepts_refunded_member() {
  let (tx, datum, utxo) = next_cycle_setup(treasury_value())
  validate_next_cycle_treasury(
    treasury_policy(),
    group_policy(),
    0,
    // group_input_index
    1,
    // group_output_index
    [1],
    // treasury_input_indices
    [0],
    // treasury_output_indices
    datum,
    utxo,
    tx,
  )
}

// [M2] Under-funded member (1M < floor 2M) cannot enter the next cycle.
test next_cycle__rejects_underfunded_restart() {
  let thin_value = assets.from_lovelace(1_000_000)
    |> assets.merge(assets.from_asset(treasury_policy(), member_tn(), 1))
  let (tx, datum, utxo) = next_cycle_setup(thin_value)
  !validate_next_cycle_treasury(
    treasury_policy(),
    group_policy(),
    0,
    1,
    [1],
    [0],
    datum,
    utxo,
    tx,
  )
}

// ─── validate_terminate_default (B2) ──────────────────────────────────────────
// Admin removes a member stuck in DefaultState after their grace window has expired.
// The membership token is burned, member_count decrements, and the forfeited collateral
// goes to the admin. test_insufficient_collateral_state() sets grace_expires_at = 5000,
// so a validity lower bound > 5000 means the grace window has expired.

// Group input with one defaulting member registered (member_count = 1).
fn terminate_group_input() -> Input {
  let gp = group_policy()
  let datum = cip68_with_group(
    GroupDatum {
      ..test_group_datum(),
      member_count: 1,
      member_token_names: [member_tn()],
    },
  )
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
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

// Group output after termination: member_count 1 → 0, member removed from registry.
fn terminate_group_output(
  member_count: Int,
  names: List<assets.AssetName>,
) -> Output {
  let gp = group_policy()
  let datum = cip68_with_group(
    GroupDatum { ..test_group_datum(), member_count, member_token_names: names },
  )
  Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

// Composes a terminate-default tx. inputs = [group(0), admin(1), treasury(2)];
// outputs = [group(0)]. validity lower bound = `lower`.
fn terminate_default_tx(
  datum: TreasuryDatum,
  group_input: Input,
  group_output: Output,
  admin_input: Input,
  mint: assets.Value,
  lower: Int,
) -> Transaction {
  let treasury_in = test_treasury_input(
    treasury_utxo_ref(),
    test_treasury_output(datum, treasury_value()),
  )
  Transaction {
    ..transaction.placeholder,
    inputs: [group_input, admin_input, treasury_in],
    outputs: [group_output],
    mint,
    validity_range: interval.after(lower),
  }
}

fn terminate_burn() -> assets.Value {
  assets.from_asset(treasury_policy(), member_tn(), -1)
}

// Happy path: grace expired (6000 > 5000), admin authorized, count decremented, token burned.
test terminate_default__accepts_after_grace_expired() {
  let datum = test_insufficient_collateral_state()
  let tx = terminate_default_tx(
    datum,
    terminate_group_input(),
    terminate_group_output(0, []),
    test_admin_input(),
    terminate_burn(),
    6000,
  )
  validate_terminate_default(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    datum,
    tx,
  )
}

// Grace not yet expired (lower bound 3000 < 5000) → grace_expired fails.
test terminate_default__rejects_before_grace_expiry() {
  let datum = test_insufficient_collateral_state()
  let tx = terminate_default_tx(
    datum,
    terminate_group_input(),
    terminate_group_output(0, []),
    test_admin_input(),
    terminate_burn(),
    3000,
  )
  !validate_terminate_default(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    datum,
    tx,
  )
}

// Boundary: lower bound exactly == grace_expires_at (5000) is NOT strictly greater → reject.
test terminate_default__rejects_at_grace_boundary() {
  let datum = test_insufficient_collateral_state()
  let tx = terminate_default_tx(
    datum,
    terminate_group_input(),
    terminate_group_output(0, []),
    test_admin_input(),
    terminate_burn(),
    5000,
  )
  !validate_terminate_default(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    datum,
    tx,
  )
}

// [security] The group spending input's token name does not match the defaulter's
// group_reference_tokenname → group_link_valid fails, isolating the treasury↔group binding
// from admin auth. The datum's link still derives the correct admin token (held by the
// admin input), so ONLY group_link_valid is violated — proving an admin of one group cannot
// drive a terminate against a treasury bound to a different group.
test terminate_default__rejects_group_link_mismatch() {
  let gp = group_policy()
  let datum = test_insufficient_collateral_state()
  // Group input carries member_b_tn() under the group policy instead of group_ref_tn().
  let mismatched_group_in = Input {
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
        |> assets.merge(assets.from_asset(gp, member_b_tn(), 1)),
      datum: InlineDatum(
        cip68_with_group(
          GroupDatum {
            ..test_group_datum(),
            member_count: 1,
            member_token_names: [member_tn()],
          },
        ),
      ),
      reference_script: None,
    },
  }
  let tx = terminate_default_tx(
    datum,
    mismatched_group_in,
    terminate_group_output(0, []),
    test_admin_input(),
    terminate_burn(),
    6000,
  )
  !validate_terminate_default(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    datum,
    tx,
  )
}

// The "admin" input does not hold the group (222) user token → admin_authorized fails.
test terminate_default__rejects_non_admin() {
  let datum = test_insufficient_collateral_state()
  let tx = terminate_default_tx(
    datum,
    terminate_group_input(),
    terminate_group_output(0, []),
    test_member_input(),
    terminate_burn(),
    6000,
  )
  !validate_terminate_default(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    datum,
    tx,
  )
}

// No membership token burned → token_burned fails (defaulter could escape forfeiture).
test terminate_default__rejects_no_burn() {
  let datum = test_insufficient_collateral_state()
  let tx = terminate_default_tx(
    datum,
    terminate_group_input(),
    terminate_group_output(0, []),
    test_admin_input(),
    assets.zero,
    6000,
  )
  !validate_terminate_default(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    datum,
    tx,
  )
}

// Group output keeps member_count = 1 (not decremented) → member_removed fails.
test terminate_default__rejects_no_count_decrement() {
  let datum = test_insufficient_collateral_state()
  let tx = terminate_default_tx(
    datum,
    terminate_group_input(),
    terminate_group_output(1, [member_tn()]),
    test_admin_input(),
    terminate_burn(),
    6000,
  )
  !validate_terminate_default(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    datum,
    tx,
  )
}

// Count decremented but the member is still listed in the registry → member_removed fails.
test terminate_default__rejects_member_left_in_registry() {
  let datum = test_insufficient_collateral_state()
  let tx = terminate_default_tx(
    datum,
    terminate_group_input(),
    terminate_group_output(0, [member_tn()]),
    test_admin_input(),
    terminate_burn(),
    6000,
  )
  !validate_terminate_default(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    datum,
    tx,
  )
}

// Datum is TreasuryState, not DefaultState → expect DefaultState crashes (fail test).
test terminate_default__rejects_non_default_state() fail {
  let datum = test_treasury_state(0)
  let tx = terminate_default_tx(
    datum,
    terminate_group_input(),
    terminate_group_output(0, []),
    test_admin_input(),
    terminate_burn(),
    6000,
  )
  validate_terminate_default(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    datum,
    tx,
  )
}

// [security C3] The group input is the attacker's forged group at a fake script → the
// trusted-binding assertion (Script(trusted_group_policy)) crashes (fail test).
test terminate_default__rejects_fake_group_script() fail {
  let fp = fake_group_policy()
  let datum = test_insufficient_collateral_state()
  let fake_group_in = Input {
    output_reference: OutputReference {
      transaction_id: #"2222222222222222222222222222222222222222222222222222222222222222",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: Script(fp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(fp, group_ref_tn(), 1)),
      datum: InlineDatum(
        cip68_with_group(
          GroupDatum {
            ..test_group_datum(),
            member_count: 1,
            member_token_names: [member_tn()],
          },
        ),
      ),
      reference_script: None,
    },
  }
  let tx = terminate_default_tx(
    datum,
    fake_group_in,
    terminate_group_output(0, []),
    test_admin_input(),
    terminate_burn(),
    6000,
  )
  validate_terminate_default(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    datum,
    tx,
  )
}
