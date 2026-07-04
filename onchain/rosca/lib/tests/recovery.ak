use aiken/interval
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use dcu/group.{GroupCip68Datum, GroupDatum, Push}
use dcu/settings
use dcu/treasury.{DefaultState, RecoveryRequest, TreasuryDatum, TreasuryState}
use dcu/treasury_actions.{run_recovery_action}
use dcu/treasury_validation.{
  validate_approve_recovery, validate_cancel_recovery, validate_execute_recovery,
  validate_propose_recovery,
}
use tests/common

// ─── Shared test helpers ──────────────────────────────────────────────────────
//
// Mirrors treasury.ak's fixture conventions: three distinct policy IDs
// (treasury/group/account) derived from common.test_hash_01/02/03, a single
// trusted group input at Script(group_policy), and signed VK-address inputs
// for every party whose signature the validator is supposed to require.

fn treasury_policy() -> assets.PolicyId {
  common.test_hash_01()
}

fn group_policy() -> assets.PolicyId {
  common.test_hash_02()
}

fn account_policy() -> assets.PolicyId {
  common.test_hash_03()
}

// Fixed 28-byte token names — distinct identities for each role in the quorum.
fn target_tn() -> assets.AssetName {
  #"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd"
}

fn new_member_tn() -> assets.AssetName {
  #"ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00"
}

fn approver_a_tn() -> assets.AssetName {
  #"11220011220011220011220011220011220011220011220011220011"
}

fn approver_b_tn() -> assets.AssetName {
  #"33440033440033440033440033440033440033440033440033440033"
}

fn non_member_tn() -> assets.AssetName {
  #"99009900990099009900990099009900990099009900990099009900"
}

fn group_ref_tn() -> assets.AssetName {
  #"001100110011001100110011001100110011001100110011001100"
}

// Distinct PKHs per signer — recoveree and approver(s) must be provably
// different identities signing independently.
fn recoveree_pkh() -> ByteArray {
  common.test_hash_01()
}

fn approver_a_pkh() -> ByteArray {
  common.test_hash_02()
}

fn approver_b_pkh() -> ByteArray {
  common.test_hash_03()
}

// Group datum: target + approver(s) are real registry members; new_member_tn
// is deliberately ABSENT (no collision). recovery_timelock mirrors common.ak's
// default (259_200_000 ms ~ 3 days).
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
    member_count: 3,
    active_member_count: 3,
    is_active: True,
    is_started: True,
    start_time: 0,
    last_distributed_round: -1,
    creator_payment_credential: VerificationKey(common.test_pkh()),
    member_token_names: [target_tn(), approver_a_tn(), approver_b_tn()],
    collateral_rounds: 1,
    payout_mode: Push,
    recovery_threshold: 1,
    recovery_timelock: 259_200_000,
    member_slots: [],
    era_start_round: 0,
    recommit_window: 259_200_000,
    reserve_join_levy: 0,
    reserve_round_levy: 0,
  }
}

fn test_group_cip68_datum() -> GroupCip68Datum {
  GroupCip68Datum {
    metadata: [Pair(#"6e616d65", "Test Group")],
    version: 1,
    extra: test_group_datum(),
  }
}

// Group UTxO at Script(group_policy) holding the ref token — the trusted
// group reference input every ProposeRecovery call reads.
fn test_group_input() -> Input {
  test_group_input_with(test_group_cip68_datum())
}

fn test_group_input_with(datum: GroupCip68Datum) -> Input {
  let gp = group_policy()
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

// [security] Attacker's FORGED group: same public ref token name, minted under an
// untrusted policy, at an always-succeeds script instead of Script(group_policy).
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
      transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
      output_index: 0,
    },
    output,
  }
}

// A signed account-token holder: VK address, holds exactly 1 of `tn` under
// account_policy. Used for both approvers and the recoveree.
fn signed_account_input(pkh: ByteArray, tn: assets.AssetName) -> Input {
  let value = assets.from_asset(account_policy(), tn, 1)
  let output = Output {
    address: Address {
      payment_credential: VerificationKey(pkh),
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

fn approver_a_input() -> Input {
  signed_account_input(approver_a_pkh(), approver_a_tn())
}

fn approver_b_input() -> Input {
  signed_account_input(approver_b_pkh(), approver_b_tn())
}

fn recoveree_input() -> Input {
  signed_account_input(recoveree_pkh(), new_member_tn())
}

// The RecoveryRequest datum a valid ProposeRecovery is expected to produce,
// given the derived approvals list and a recomputed earliest_execution_slot.
fn test_recovery_request_datum(
  approvals: List<assets.AssetName>,
) -> TreasuryDatum {
  RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: target_tn(),
    new_member_tokenname: new_member_tn(),
    new_payment_credential: recoveree_pkh(),
    earliest_execution_slot: 259_200_000,
    approvals,
  }
}

fn test_request_output(datum: TreasuryDatum) -> Output {
  let tp = treasury_policy()
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
  Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

// Builds a baseline valid ProposeRecovery transaction: group at reference_inputs
// index 0 (read-only — ProposeRecovery never spends the group), recoveree +
// approver_a signed spending inputs, request output at index 0. validity_range
// lower bound = 0 so earliest_execution_slot == 0 + recovery_timelock (259_200_000).
fn valid_tx() -> Transaction {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()

  let approvals = [approver_a_tn()]
  let request_output = test_request_output(
    test_recovery_request_datum(approvals),
  )

  Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh()],
    validity_range: interval.after(0),
  }
}

// ─── propose_recovery__accepts_valid ──────────────────────────────────────────

test propose_recovery__accepts_valid() {
  let tx = valid_tx()

  // group_ref_input_index=0 (reference_inputs), request_output_index=0,
  // approver_input_indices=[1] (approver_a in inputs)
  validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

// Two independent approvals — confirms multiple signers are each counted once
// and the derived set matches the datum exactly.
test propose_recovery__accepts_valid_two_approvals() {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()
  let approver_b = approver_b_input()

  let approvals = [approver_a_tn(), approver_b_tn()]
  let request_output = test_request_output(
    test_recovery_request_datum(approvals),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a, approver_b],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh(), approver_b_pkh()],
    validity_range: interval.after(0),
  }

  validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1, 2],
    tx,
  )
}

// ─── Negative: trust / membership ─────────────────────────────────────────────

test propose_recovery__rejects_target_not_in_registry() {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()

  let approvals = [approver_a_tn()]
  let datum = RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: non_member_tn(),
    new_member_tokenname: new_member_tn(),
    new_payment_credential: recoveree_pkh(),
    earliest_execution_slot: 259_200_000,
    approvals,
  }
  let request_output = test_request_output(datum)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh()],
    validity_range: interval.after(0),
  }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

test propose_recovery__rejects_new_token_already_member() {
  // new_member_tokenname collides with an EXISTING member (approver_b, who is
  // already in the registry) — no real rotation, just identity duplication.
  let group_input = test_group_input()
  let recoveree = signed_account_input(recoveree_pkh(), approver_b_tn())
  let approver_a = approver_a_input()

  let approvals = [approver_a_tn()]
  let datum = RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: target_tn(),
    new_member_tokenname: approver_b_tn(),
    new_payment_credential: recoveree_pkh(),
    earliest_execution_slot: 259_200_000,
    approvals,
  }
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(treasury_policy(), approver_b_tn(), 1))
  let request_output = Output {
    address: Address {
      payment_credential: Script(treasury_policy()),
      stake_credential: None,
    },
    value,
    datum: InlineDatum(datum),
    reference_script: None,
  }

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), approver_b_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh()],
    validity_range: interval.after(0),
  }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

// Recoveree HOLDS N' but never SIGNED (their PKH is absent from
// extra_signatories) — bearer presence without consent must be rejected.
test propose_recovery__rejects_recoveree_not_signed() {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()

  let approvals = [approver_a_tn()]
  let request_output = test_request_output(
    test_recovery_request_datum(approvals),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    // recoveree_pkh() deliberately omitted
    extra_signatories: [approver_a_pkh()],
    validity_range: interval.after(0),
  }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

// The core "reference-presence != approval" test: approver_a's account token is
// referenced as an input, but their PKH is NOT in extra_signatories — proves
// existence, not consent. Must crash inside signed_account_token_name.
test propose_recovery__rejects_approver_not_signed() fail {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()

  let approvals = [approver_a_tn()]
  let request_output = test_request_output(
    test_recovery_request_datum(approvals),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    // approver_a_pkh() deliberately omitted — only the recoveree signed
    extra_signatories: [recoveree_pkh()],
    validity_range: interval.after(0),
  }

  validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

// A signed account token whose holder is NOT a registry member at all — signing
// proves identity, not membership; the registry check must still reject it.
test propose_recovery__rejects_approver_not_member() {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let non_member_pkh = #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  let non_member_input = signed_account_input(non_member_pkh, non_member_tn())

  let approvals = [non_member_tn()]
  let request_output = test_request_output(
    test_recovery_request_datum(approvals),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, non_member_input],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), non_member_pkh],
    validity_range: interval.after(0),
  }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

// Same signed approver input referenced twice via approver_input_indices —
// must not be allowed to count toward quorum twice.
test propose_recovery__rejects_duplicate_approval() {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()

  let approvals = [approver_a_tn(), approver_a_tn()]
  let request_output = test_request_output(
    test_recovery_request_datum(approvals),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh()],
    validity_range: interval.after(0),
  }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1, 1],
    tx,
  )
}

// The lost member's own token cannot appear among the approvals (self-vouch).
test propose_recovery__rejects_target_in_approvals() {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  // target_tn() signs and is referenced as an "approver" for itself
  let target_as_approver = signed_account_input(approver_a_pkh(), target_tn())

  let approvals = [target_tn()]
  let request_output = test_request_output(
    test_recovery_request_datum(approvals),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, target_as_approver],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh()],
    validity_range: interval.after(0),
  }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

// earliest_execution_slot in the output datum does not equal
// get_lower_bound(tx) + group.recovery_timelock — must be rejected even though
// every other field is valid (the timelock cannot be caller-supplied).
test propose_recovery__rejects_wrong_earliest_execution_slot() {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()

  let approvals = [approver_a_tn()]
  let datum = RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: target_tn(),
    new_member_tokenname: new_member_tn(),
    new_payment_credential: recoveree_pkh(),
    // Should be 259_200_000 (0 + recovery_timelock); shortened here
    earliest_execution_slot: 1,
    approvals,
  }
  let request_output = test_request_output(datum)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh()],
    validity_range: interval.after(0),
  }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

// The recoveree genuinely holds N' and signs (proving control of N'), and the
// quorum signs — but new_payment_credential is set to an attacker's PKH rather
// than the recoveree's own signing key. Holding/signing N' does NOT authorise an
// arbitrary payout address, so the recovered member's future Push payouts would
// route to the attacker. Must reject: new_payment_credential is bound to the
// recoveree's signing key.
test propose_recovery__rejects_new_payment_credential_not_recoveree() {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()

  let attacker_pkh = #"abababababababababababababababababababababababababababab00"
  let approvals = [approver_a_tn()]
  let datum = RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: target_tn(),
    new_member_tokenname: new_member_tn(),
    // Recoveree controls N' and signs, but the payout address is the attacker's
    new_payment_credential: attacker_pkh,
    earliest_execution_slot: 259_200_000,
    approvals,
  }
  let request_output = test_request_output(datum)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh()],
    validity_range: interval.after(0),
  }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

// ─── Negative: mint discipline ────────────────────────────────────────────────

test propose_recovery__rejects_extra_mint() {
  let tx = valid_tx()
  let extra_mint = assets.from_asset(treasury_policy(), new_member_tn(), 1)
    |> assets.merge(assets.from_asset(treasury_policy(), non_member_tn(), 1))
  let bad_tx = Transaction { ..tx, mint: extra_mint }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    bad_tx,
  )
}

test propose_recovery__rejects_wrong_mint_name() {
  let tx = valid_tx()
  let bad_mint = assets.from_asset(treasury_policy(), non_member_tn(), 1)
  let bad_tx = Transaction { ..tx, mint: bad_mint }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    bad_tx,
  )
}

// ─── Negative: output discipline ──────────────────────────────────────────────

test propose_recovery__rejects_request_not_at_script() {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()

  let approvals = [approver_a_tn()]
  let datum = test_recovery_request_datum(approvals)
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(treasury_policy(), new_member_tn(), 1))
  // Output sits at a VK wallet address instead of Script(own_policy_id)
  let request_output = Output {
    address: Address {
      payment_credential: VerificationKey(common.test_pkh()),
      stake_credential: None,
    },
    value,
    datum: InlineDatum(datum),
    reference_script: None,
  }

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh()],
    validity_range: interval.after(0),
  }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

// The output's approvals field claims MORE than what was actually
// signature-verified (approver_b never signed, never referenced) — the derived
// set ([approver_a_tn()]) must not match the inflated claim.
test propose_recovery__rejects_request_datum_mismatch() {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()

  // Datum claims TWO approvals; only one (approver_a, index 1) is actually
  // verified by approver_input_indices below.
  let inflated_approvals = [approver_a_tn(), approver_b_tn()]
  let request_output = test_request_output(
    test_recovery_request_datum(inflated_approvals),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh()],
    validity_range: interval.after(0),
  }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

// [security C1/C2/C3] Forged group input at an untrusted script — same public ref
// token name, but NOT at Script(trusted_group_policy). Must crash on the
// trusted-binding assertion before any registry/timelock logic runs.
test propose_recovery__rejects_fake_group_script() fail {
  let group_input = fake_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()

  let approvals = [approver_a_tn()]
  let request_output = test_request_output(
    test_recovery_request_datum(approvals),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [recoveree, approver_a],
    reference_inputs: [group_input],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh()],
    validity_range: interval.after(0),
  }

  validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [1],
    tx,
  )
}

// ─── ApproveRecovery tests ────────────────────────────────────────────────────
//
// Shared fixture conventions (mirrors ProposeRecovery above):
//   - treasury_policy / group_policy / account_policy from test_hash_01/02/03
//   - group is a REFERENCE input (ApproveRecovery never spends the group)
//   - the spent RecoveryRequest UTxO sits at Script(treasury_policy), holds N'
//   - the approver is a spending input at a VK address whose PKH signed
//
// Starting state: the request has one existing approval (approver_a).
// The new approver being tested is approver_b (a different registry member).

// The RecoveryRequest UTxO being spent (output_reference used for self-reference).
fn request_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
    output_index: 0,
  }
}

// A RecoveryRequest datum with a caller-supplied approvals list.
fn approve_request_datum(approvals: List<assets.AssetName>) -> TreasuryDatum {
  RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: target_tn(),
    new_member_tokenname: new_member_tn(),
    new_payment_credential: recoveree_pkh(),
    earliest_execution_slot: 259_200_000,
    approvals,
  }
}

// The spent RecoveryRequest UTxO (at Script(treasury_policy), holding N').
fn request_input_utxo(datum: TreasuryDatum) -> Input {
  let tp = treasury_policy()
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
  let output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
  Input { output_reference: request_ref(), output }
}

// The continuing RecoveryRequest output.
fn approve_request_output(datum: TreasuryDatum) -> Output {
  let tp = treasury_policy()
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
  Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

// Builds a valid ApproveRecovery tx: group as reference input (index 0), the
// request UTxO as spending input (index 0), approver_b as spending input (index 1).
// The request begins with [approver_a_tn()] and grows to [approver_a_tn(), approver_b_tn()].
fn valid_approve_tx() -> Transaction {
  let existing_approvals = [approver_a_tn()]
  let updated_approvals = [approver_a_tn(), approver_b_tn()]

  let request_in = request_input_utxo(approve_request_datum(existing_approvals))
  let approver_b = approver_b_input()
  let request_out = approve_request_output(
    approve_request_datum(updated_approvals),
  )
  let group_ref = test_group_input()

  Transaction {
    ..transaction.placeholder,
    inputs: [request_in, approver_b],
    reference_inputs: [group_ref],
    outputs: [request_out],
    mint: assets.zero,
    extra_signatories: [approver_b_pkh()],
    validity_range: interval.after(0),
  }
}

// Helper to call validate_approve_recovery with the canonical indices for valid_approve_tx:
//   group_ref_input_index=0 (reference_inputs)
//   request_input_index=0 (inputs — the RecoveryRequest UTxO)
//   request_output_index=0 (outputs)
//   approver_input_index=1 (inputs — approver_b)
fn call_approve(tx: Transaction) -> Bool {
  validate_approve_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    0,
    1,
    request_ref(),
    tx,
  )
}

// ─── Happy path ───────────────────────────────────────────────────────────────

// Baseline: approver_b signs and their approval is appended; all other datum
// fields frozen; N' preserved in the output; no mint.
test approve_recovery__appends_distinct_approval() {
  call_approve(valid_approve_tx())
}

// ─── Negative: approver auth ──────────────────────────────────────────────────

// Account token present at a VK address BUT the PKH is NOT in extra_signatories —
// reference-presence != approval. Must crash inside signed_account_token_name.
test approve_recovery__rejects_unsigned_approver() fail {
  let tx = valid_approve_tx()
  let bad_tx = Transaction { ..tx, extra_signatories: [] }
  call_approve(bad_tx)
}

// Signed input holds a token name that is NOT in the group registry.
test approve_recovery__rejects_non_member_approver() {
  let non_member_pkh = #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  let non_member_in = signed_account_input(non_member_pkh, non_member_tn())

  let existing_approvals = [approver_a_tn()]
  let updated_approvals = [approver_a_tn(), non_member_tn()]
  let request_in = request_input_utxo(approve_request_datum(existing_approvals))
  let request_out = approve_request_output(
    approve_request_datum(updated_approvals),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [request_in, non_member_in],
    reference_inputs: [test_group_input()],
    outputs: [request_out],
    mint: assets.zero,
    extra_signatories: [non_member_pkh],
    validity_range: interval.after(0),
  }
  !call_approve(tx)
}

// approver_a is already in existing_approvals — double-counting must be rejected.
test approve_recovery__rejects_duplicate_approval() {
  let existing_approvals = [approver_a_tn()]
  let updated_approvals = [approver_a_tn(), approver_a_tn()]
  let request_in = request_input_utxo(approve_request_datum(existing_approvals))
  let request_out = approve_request_output(
    approve_request_datum(updated_approvals),
  )

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [request_in, approver_a_input()],
    reference_inputs: [test_group_input()],
    outputs: [request_out],
    mint: assets.zero,
    extra_signatories: [approver_a_pkh()],
    validity_range: interval.after(0),
  }
  !call_approve(tx)
}

// The target member's own account token is used as the approver — self-vouch, reject.
test approve_recovery__rejects_target_as_approver() {
  let existing_approvals: List<assets.AssetName> = []
  let updated_approvals = [target_tn()]
  let request_in = request_input_utxo(approve_request_datum(existing_approvals))
  let request_out = approve_request_output(
    approve_request_datum(updated_approvals),
  )
  let target_as_approver = signed_account_input(approver_a_pkh(), target_tn())

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [request_in, target_as_approver],
    reference_inputs: [test_group_input()],
    outputs: [request_out],
    mint: assets.zero,
    extra_signatories: [approver_a_pkh()],
    validity_range: interval.after(0),
  }
  !call_approve(tx)
}

// ─── Negative: datum mutation ─────────────────────────────────────────────────

// The output datum changes a frozen field (target_token swapped) — all non-approvals
// fields must be immutable.
test approve_recovery__rejects_datum_mutation() {
  let existing_approvals = [approver_a_tn()]
  let updated_approvals = [approver_a_tn(), approver_b_tn()]
  let request_in = request_input_utxo(approve_request_datum(existing_approvals))
  let mutated_out_datum = RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: non_member_tn(),
    new_member_tokenname: new_member_tn(),
    new_payment_credential: recoveree_pkh(),
    earliest_execution_slot: 259_200_000,
    approvals: updated_approvals,
  }
  let request_out = approve_request_output(mutated_out_datum)

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [request_in, approver_b_input()],
    reference_inputs: [test_group_input()],
    outputs: [request_out],
    mint: assets.zero,
    extra_signatories: [approver_b_pkh()],
    validity_range: interval.after(0),
  }
  !call_approve(tx)
}

// ─── Negative: value skim ─────────────────────────────────────────────────────

// N' is missing from the request output — the authenticating token must be preserved.
test approve_recovery__rejects_value_skim() {
  let existing_approvals = [approver_a_tn()]
  let updated_approvals = [approver_a_tn(), approver_b_tn()]
  let request_in = request_input_utxo(approve_request_datum(existing_approvals))
  let skimmed_value = assets.from_lovelace(2_000_000)
  let skimmed_out = Output {
    address: Address {
      payment_credential: Script(treasury_policy()),
      stake_credential: None,
    },
    value: skimmed_value,
    datum: InlineDatum(approve_request_datum(updated_approvals)),
    reference_script: None,
  }

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [request_in, approver_b_input()],
    reference_inputs: [test_group_input()],
    outputs: [skimmed_out],
    mint: assets.zero,
    extra_signatories: [approver_b_pkh()],
    validity_range: interval.after(0),
  }
  !call_approve(tx)
}

// ─── Negative: address ───────────────────────────────────────────────────────

// The request output sits at a VK wallet instead of Script(treasury_policy).
test approve_recovery__rejects_request_not_at_script() {
  let existing_approvals = [approver_a_tn()]
  let updated_approvals = [approver_a_tn(), approver_b_tn()]
  let request_in = request_input_utxo(approve_request_datum(existing_approvals))
  let tp = treasury_policy()
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
  let wallet_out = Output {
    address: Address {
      payment_credential: VerificationKey(common.test_pkh()),
      stake_credential: None,
    },
    value,
    datum: InlineDatum(approve_request_datum(updated_approvals)),
    reference_script: None,
  }

  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [request_in, approver_b_input()],
    reference_inputs: [test_group_input()],
    outputs: [wallet_out],
    mint: assets.zero,
    extra_signatories: [approver_b_pkh()],
    validity_range: interval.after(0),
  }
  !call_approve(tx)
}

// ─── Negative: mint discipline ────────────────────────────────────────────────

// Any mint under the treasury policy in an approve tx must be rejected —
// ApproveRecovery neither mints nor burns.
test approve_recovery__rejects_mint() {
  let tx = valid_approve_tx()
  let bad_tx = Transaction {
    ..tx,
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
  }
  !call_approve(bad_tx)
}

// ─── CancelRecovery tests ─────────────────────────────────────────────────────
//
// CancelRecovery is the VETO: it destroys a pending RecoveryRequest and burns the
// authenticating N' token. Two authorization paths:
//   (a) The real holder of the target token presents+signs it — proves the token is
//       NOT lost. Valid at ANY time, including before earliest_execution_slot.
//   (b) A member whose token name appears in the request's approvals list signs —
//       a proposer or approver withdraws their support.
//
// Shared fixtures re-use the ApproveRecovery constants (treasury_policy, group_policy,
// account_policy, token names, PKHs). The request used in these tests starts with
// approvals = [approver_a_tn(), approver_b_tn()] so both (a) and (b) can be tested.

// The RecoveryRequest spent by CancelRecovery (reuses request_ref() from ApproveRecovery).
fn cancel_request_datum() -> TreasuryDatum {
  RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: target_tn(),
    new_member_tokenname: new_member_tn(),
    new_payment_credential: recoveree_pkh(),
    earliest_execution_slot: 259_200_000,
    approvals: [approver_a_tn(), approver_b_tn()],
  }
}

fn cancel_request_input() -> Input {
  let tp = treasury_policy()
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
  let output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value,
    datum: InlineDatum(cancel_request_datum()),
    reference_script: None,
  }
  Input { output_reference: request_ref(), output }
}

// The exact burn: {N': -1} under own (treasury) policy, nothing else.
fn n_prime_burn() -> assets.Value {
  assets.from_asset(treasury_policy(), new_member_tn(), -1)
}

// Signed input for the target (the supposedly-lost token holder proves control).
fn target_holder_input() -> Input {
  // A DIFFERENT pkh from recoveree_pkh() to show path (a) doesn't need to be
  // the recoveree who proposed; any entity holding target_tn() and signing works.
  let holder_pkh = #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  signed_account_input(holder_pkh, target_tn())
}

fn target_holder_pkh() -> ByteArray {
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}

// Helper to call validate_cancel_recovery with canonical indices:
//   request_input_index=0, account inputs in remaining positions.
fn call_cancel(tx: Transaction) -> Bool {
  validate_cancel_recovery(
    treasury_policy(),
    account_policy(),
    0,
    request_ref(),
    tx,
  )
}

// ─── Happy path (a): veto by real target-token holder ──────────────────────────

// The genuine holder of target_tn() presents+signs it → request consumed, N' burned.
test cancel_recovery__veto_by_signed_target_holder() {
  let target_holder = target_holder_input()
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [cancel_request_input(), target_holder],
    reference_inputs: [],
    outputs: [],
    mint: n_prime_burn(),
    extra_signatories: [target_holder_pkh()],
    validity_range: interval.after(0),
  }
  call_cancel(tx)
}

// ─── Happy path (b): withdrawal by a signed approver ─────────────────────────

// approver_b is in the approvals list and signs → cancel accepted.
test cancel_recovery__withdrawal_by_signed_approver() {
  let approver_b = approver_b_input()
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [cancel_request_input(), approver_b],
    reference_inputs: [],
    outputs: [],
    mint: n_prime_burn(),
    extra_signatories: [approver_b_pkh()],
    validity_range: interval.after(0),
  }
  call_cancel(tx)
}

// ─── Veto completeness: works before timelock, with full approvals ─────────────

// lower_bound = 0 < earliest_execution_slot = 259_200_000.
// The request already has a FULL approvals set ([approver_a_tn(), approver_b_tn()]).
// The true target holder can still veto immediately — no timelock gate, no quorum
// precondition on path (a).
test cancel_recovery__veto_works_before_timelock() {
  let target_holder = target_holder_input()
  // validity_range lower bound deliberately set BEFORE the timelock
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [cancel_request_input(), target_holder],
    reference_inputs: [],
    outputs: [],
    mint: n_prime_burn(),
    extra_signatories: [target_holder_pkh()],
    validity_range: interval.after(0),
  }
  call_cancel(tx)
}

// ─── Negative: random party cannot cancel ────────────────────────────────────

// A signed party who holds an account token but is neither the target_token holder
// nor in the approvals list → reject.
test cancel_recovery__rejects_random_party() {
  let non_member_pkh = #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  let random_input = signed_account_input(non_member_pkh, non_member_tn())
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [cancel_request_input(), random_input],
    reference_inputs: [],
    outputs: [],
    mint: n_prime_burn(),
    extra_signatories: [non_member_pkh],
    validity_range: interval.after(0),
  }
  !call_cancel(tx)
}

// ─── Negative: unsigned target holder ────────────────────────────────────────

// Holds target_tn() but PKH is NOT in extra_signatories — bearer presence without
// consent. signed_account_token_name crashes on this path → `fail` annotation.
test cancel_recovery__rejects_unsigned_target_holder() fail {
  let unsigned_holder = target_holder_input()
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [cancel_request_input(), unsigned_holder],
    reference_inputs: [],
    outputs: [],
    mint: n_prime_burn(),
    // PKH deliberately absent
    extra_signatories: [],
    validity_range: interval.after(0),
  }
  // If the crash is reached first (signed_account_token_name fails), test passes as `fail`.
  // The boolean fallback also covers if we try path (b) and it returns False.
  call_cancel(tx)
}

// ─── Negative: N' not burned ──────────────────────────────────────────────────

// Target holder signs and is present, but mint has NO burn of N' → reject.
test cancel_recovery__rejects_n_prime_not_burned() {
  let target_holder = target_holder_input()
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [cancel_request_input(), target_holder],
    reference_inputs: [],
    outputs: [],
    mint: assets.zero,
    extra_signatories: [target_holder_pkh()],
    validity_range: interval.after(0),
  }
  !call_cancel(tx)
}

// ─── Negative: wrong token burned ────────────────────────────────────────────

// The burn is for `non_member_tn()` (a completely different token name) rather
// than the request's `new_member_tokenname` (N') → reject.
test cancel_recovery__rejects_wrong_token_burned() {
  let target_holder = target_holder_input()
  let wrong_burn = assets.from_asset(treasury_policy(), non_member_tn(), -1)
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [cancel_request_input(), target_holder],
    reference_inputs: [],
    outputs: [],
    mint: wrong_burn,
    extra_signatories: [target_holder_pkh()],
    validity_range: interval.after(0),
  }
  !call_cancel(tx)
}

// ─── Negative: extra mint/burn alongside N' burn ──────────────────────────────

// N' IS burned, but an additional token is also minted under own policy.
// The exact-one-burn check must catch this.
test cancel_recovery__rejects_extra_mint_or_burn() {
  let target_holder = target_holder_input()
  let extra_mint = n_prime_burn()
    |> assets.merge(assets.from_asset(treasury_policy(), non_member_tn(), 1))
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [cancel_request_input(), target_holder],
    reference_inputs: [],
    outputs: [],
    mint: extra_mint,
    extra_signatories: [target_holder_pkh()],
    validity_range: interval.after(0),
  }
  !call_cancel(tx)
}

// ─── ExecuteRecovery tests ─────────────────────────────────────────────────────
//
// ExecuteRecovery is the treasury-side half of the lost-member identity rotation.
// It runs on BOTH spent treasury UTxOs (the RecoveryRequest and the member's
// treasury UTxO) and validates the full rotation in one global function.
//
// Layout (canonical index set for the happy-path tx):
//   inputs[0]  = group spending input (RecoverMember redeemer)
//   inputs[1]  = RecoveryRequest UTxO  (holds N', datum RecoveryRequest)
//   inputs[2]  = member treasury UTxO  (holds N,  datum TreasuryState or DefaultState)
//   outputs[0] = group output          (registry N→N' swapped)
//   outputs[1] = rotated treasury      (holds N', datum TreasuryState with N→N', new cred)
//
// Redeemer indices (ExecuteRecovery):
//   group_ref_input_index       = 0
//   group_output_index          = 0
//   request_input_index         = 1
//   member_treasury_input_index = 2
//   member_treasury_output_index= 1

// ─── ExecuteRecovery fixture helpers ──────────────────────────────────────────

// Earliest execution slot used in all execute tests.
fn earliest_slot() -> Int {
  259_200_000
}

// A request datum with full approvals (threshold = 1, so approver_a alone qualifies).
fn execute_request_datum() -> TreasuryDatum {
  RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: target_tn(),
    new_member_tokenname: new_member_tn(),
    new_payment_credential: recoveree_pkh(),
    earliest_execution_slot: earliest_slot(),
    approvals: [approver_a_tn()],
  }
}

// OutputReference for the RecoveryRequest UTxO (distinct from previous fixtures).
fn exec_request_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"4444444444444444444444444444444444444444444444444444444444444444",
    output_index: 0,
  }
}

// OutputReference for the member treasury UTxO.
fn exec_member_treasury_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"5555555555555555555555555555555555555555555555555555555555555555",
    output_index: 0,
  }
}

// The RecoveryRequest spending input (holds N').
fn exec_request_input() -> Input {
  let tp = treasury_policy()
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
  let output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value,
    datum: InlineDatum(execute_request_datum()),
    reference_script: None,
  }
  Input { output_reference: exec_request_ref(), output }
}

// A normal TreasuryState member UTxO (the lost member's position, holds N).
fn member_treasury_datum() -> TreasuryDatum {
  TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: target_tn(),
    rounds_paid: 2,
    member_payment_credential: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    claimable_balance: 500_000,
  }
}

fn exec_member_treasury_input() -> Input {
  let tp = treasury_policy()
  let value = assets.from_lovelace(4_000_000)
    |> assets.merge(assets.from_asset(tp, target_tn(), 1))
  let output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value,
    datum: InlineDatum(member_treasury_datum()),
    reference_script: None,
  }
  Input { output_reference: exec_member_treasury_ref(), output }
}

// Group datum with recovery_threshold = 1 (1 approval needed), 3 members.
fn exec_group_datum() -> GroupDatum {
  GroupDatum { ..test_group_datum(), recovery_threshold: 1, member_count: 3 }
}

fn exec_group_cip68_datum() -> GroupCip68Datum {
  GroupCip68Datum {
    metadata: [Pair(#"6e616d65", "Test Group")],
    version: 1,
    extra: exec_group_datum(),
  }
}

// OutputReference for the group UTxO.
fn exec_group_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"6666666666666666666666666666666666666666666666666666666666666666",
    output_index: 0,
  }
}

// Group spending input (RecoverMember redeemer — so it is in tx.inputs, not reference_inputs).
fn exec_group_input() -> Input {
  let gp = group_policy()
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value,
    datum: InlineDatum(exec_group_cip68_datum()),
    reference_script: None,
  }
  Input { output_reference: exec_group_ref(), output }
}

// Group output with the registry swapped N→N'.
fn exec_group_output() -> Output {
  let gp = group_policy()
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1))
  let swapped_datum = GroupCip68Datum {
    ..exec_group_cip68_datum(),
    extra: GroupDatum {
      ..exec_group_datum(),
      member_token_names: [approver_a_tn(), approver_b_tn(), new_member_tn()],
    },
  }
  Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value,
    datum: InlineDatum(swapped_datum),
    reference_script: None,
  }
}

// The expected rotated treasury output: holds N', same economic fields but
// member_reference_tokenname → N' and member_payment_credential → new_payment_credential.
fn rotated_treasury_output() -> Output {
  let tp = treasury_policy()
  // Same lovelace and value as the member treasury input (4_000_000 lovelace + N').
  // N' comes from the request UTxO and moves into this output; N is burned.
  let value = assets.from_lovelace(4_000_000)
    |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
  let rotated_datum = TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: new_member_tn(),
    rounds_paid: 2,
    member_payment_credential: recoveree_pkh(),
    claimable_balance: 500_000,
  }
  Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value,
    datum: InlineDatum(rotated_datum),
    reference_script: None,
  }
}

// Burn of N only (N' is relocated from request, not freshly minted here).
fn execute_mint() -> assets.Value {
  assets.from_asset(treasury_policy(), target_tn(), -1)
}

// Helper: the canonical happy-path tx where the timelock has passed.
fn valid_execute_tx() -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      exec_group_input(),
      exec_request_input(),
      exec_member_treasury_input(),
    ],
    reference_inputs: [],
    outputs: [exec_group_output(), rotated_treasury_output()],
    mint: execute_mint(),
    extra_signatories: [],
    // lower_bound == earliest_slot() — exactly at the timelock, should pass
    validity_range: interval.after(earliest_slot()),
  }
}

// Canonical call helper (matches the canonical index layout above).
fn call_execute(tx: Transaction) -> Bool {
  validate_execute_recovery(
    treasury_policy(),
    group_policy(),
    0,
    0,
    1,
    2,
    1,
    exec_request_ref(),
    exec_member_treasury_ref(),
    tx,
  )
}

// ─── Happy path: TreasuryState ────────────────────────────────────────────────

// Baseline: timelock passed, approval count >= threshold, N burned, N' relocated,
// economic fields preserved, payment credential rotated to new_payment_credential.
test execute_recovery__rotates_after_timelock_at_threshold() {
  call_execute(valid_execute_tx())
}

// ─── Happy path: DefaultState ─────────────────────────────────────────────────

// The lost member's treasury is in DefaultState (grace window). The rotation still
// completes: all DefaultState fields preserved, member_payment_credential updated.
test execute_recovery__rotates_from_default_state() {
  let tp = treasury_policy()
  let default_datum = DefaultState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: target_tn(),
    grace_expires_at: 999_999_999,
    grace_extensions_used: 1,
    rounds_paid: 2,
    member_payment_credential: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    claimable_balance: 500_000,
  }
  let default_input_value = assets.from_lovelace(4_000_000)
    |> assets.merge(assets.from_asset(tp, target_tn(), 1))
  let default_input = Input {
    output_reference: exec_member_treasury_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(tp),
        stake_credential: None,
      },
      value: default_input_value,
      datum: InlineDatum(default_datum),
      reference_script: None,
    },
  }
  let rotated_default_output_value = assets.from_lovelace(4_000_000)
    |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
  let rotated_default_datum = DefaultState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: new_member_tn(),
    grace_expires_at: 999_999_999,
    grace_extensions_used: 1,
    rounds_paid: 2,
    member_payment_credential: recoveree_pkh(),
    claimable_balance: 500_000,
  }
  let rotated_default_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value: rotated_default_output_value,
    datum: InlineDatum(rotated_default_datum),
    reference_script: None,
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    inputs: [exec_group_input(), exec_request_input(), default_input],
    outputs: [exec_group_output(), rotated_default_output],
  }
  call_execute(tx)
}

// ─── Negative: timelock not yet passed ────────────────────────────────────────

// Lower bound is 1 ms before the earliest_execution_slot — must reject.
test execute_recovery__rejects_before_timelock() {
  let tx = Transaction {
    ..valid_execute_tx(),
    validity_range: interval.after(earliest_slot() - 1),
  }
  !call_execute(tx)
}

// ─── Negative: below threshold ────────────────────────────────────────────────

// Only 0 approvals in the request (threshold=1) — must reject.
test execute_recovery__rejects_below_threshold() {
  let tp = treasury_policy()
  let no_approval_request_datum = RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: target_tn(),
    new_member_tokenname: new_member_tn(),
    new_payment_credential: recoveree_pkh(),
    earliest_execution_slot: earliest_slot(),
    approvals: [],
  }
  let request_value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
  let bad_request_input = Input {
    output_reference: exec_request_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(tp),
        stake_credential: None,
      },
      value: request_value,
      datum: InlineDatum(no_approval_request_datum),
      reference_script: None,
    },
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    inputs: [
      exec_group_input(),
      bad_request_input,
      exec_member_treasury_input(),
    ],
  }
  !call_execute(tx)
}

// ─── Negative: threshold above member_count ───────────────────────────────────

// Group has member_count=3 but recovery_threshold=4 — sanity check must reject.
test execute_recovery__rejects_threshold_above_member_count() {
  let gp = group_policy()
  let bad_group_datum = GroupDatum {
    ..exec_group_datum(),
    recovery_threshold: 4,
  }
  let bad_group_cip68 = GroupCip68Datum {
    ..exec_group_cip68_datum(),
    extra: bad_group_datum,
  }
  let bad_group_input = Input {
    output_reference: exec_group_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(bad_group_cip68),
      reference_script: None,
    },
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    inputs: [
      bad_group_input,
      exec_request_input(),
      exec_member_treasury_input(),
    ],
  }
  !call_execute(tx)
}

// ─── Threshold clamp: shrunken group keeps a reachable quorum ─────────────────

// recovery_threshold == member_count (3): the lost member can never self-vouch, so at
// most 2 approvals are achievable and the configured threshold is unreachable. The
// clamp (min(threshold, member_count - 1), floored at 1) makes ALL remaining members
// vouching sufficient — recovery is not permanently lost.
test execute_recovery__accepts_shrunken_group_all_remaining_vouch() {
  let tp = treasury_policy()
  let gp = group_policy()
  let full_quorum_request_datum = RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: target_tn(),
    new_member_tokenname: new_member_tn(),
    new_payment_credential: recoveree_pkh(),
    earliest_execution_slot: earliest_slot(),
    approvals: [approver_a_tn(), approver_b_tn()],
  }
  let request_input = Input {
    output_reference: exec_request_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(tp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(tp, new_member_tn(), 1)),
      datum: InlineDatum(full_quorum_request_datum),
      reference_script: None,
    },
  }
  let strict_group_datum = GroupDatum {
    ..exec_group_datum(),
    recovery_threshold: 3,
  }
  let strict_group_input = Input {
    output_reference: exec_group_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(
        GroupCip68Datum {
          ..exec_group_cip68_datum(),
          extra: strict_group_datum,
        },
      ),
      reference_script: None,
    },
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    inputs: [strict_group_input, request_input, exec_member_treasury_input()],
  }
  call_execute(tx)
}

// ─── Registry re-check: exited approvers are discounted ──────────────────────

// The single approval came from a member whose token is NO LONGER in the registry
// (they exited after vouching). Discounted, valid approvals drop to 0 — reject.
test execute_recovery__rejects_exited_approver_below_threshold() {
  let gp = group_policy()
  let shrunk_group_datum = GroupDatum {
    ..exec_group_datum(),
    member_count: 2,
    member_token_names: [target_tn(), approver_b_tn()],
  }
  let shrunk_group_input = Input {
    output_reference: exec_group_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(
        GroupCip68Datum {
          ..exec_group_cip68_datum(),
          extra: shrunk_group_datum,
        },
      ),
      reference_script: None,
    },
  }
  // Request approvals = [approver_a] — who exited (absent from the registry above).
  let tx = Transaction {
    ..valid_execute_tx(),
    inputs: [
      shrunk_group_input,
      exec_request_input(),
      exec_member_treasury_input(),
    ],
  }
  !call_execute(tx)
}

// One approver exited (discounted) but another approval remains from a current
// member — quorum still met, rotation proceeds.
test execute_recovery__accepts_with_exited_approver_discounted() {
  let tp = treasury_policy()
  let gp = group_policy()
  let two_approval_request_datum = RecoveryRequest {
    group_reference_tokenname: group_ref_tn(),
    target_token: target_tn(),
    new_member_tokenname: new_member_tn(),
    new_payment_credential: recoveree_pkh(),
    earliest_execution_slot: earliest_slot(),
    approvals: [approver_a_tn(), approver_b_tn()],
  }
  let request_input = Input {
    output_reference: exec_request_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(tp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(tp, new_member_tn(), 1)),
      datum: InlineDatum(two_approval_request_datum),
      reference_script: None,
    },
  }
  // approver_a exited; approver_b is still a member. threshold=1 → [b] suffices.
  let shrunk_group_datum = GroupDatum {
    ..exec_group_datum(),
    member_count: 2,
    member_token_names: [target_tn(), approver_b_tn()],
  }
  let shrunk_group_input = Input {
    output_reference: exec_group_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(
        GroupCip68Datum {
          ..exec_group_cip68_datum(),
          extra: shrunk_group_datum,
        },
      ),
      reference_script: None,
    },
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    inputs: [shrunk_group_input, request_input, exec_member_treasury_input()],
  }
  call_execute(tx)
}

// ─── Negative: economic field mutation ────────────────────────────────────────

// The output changes rounds_paid — the rotation must preserve all economic fields exactly.
test execute_recovery__rejects_economic_field_mutation() {
  let tp = treasury_policy()
  let mutated_datum = TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: new_member_tn(),
    // rounds_paid incremented — NOT allowed; rotation freezes all economic fields
    rounds_paid: 99,
    member_payment_credential: recoveree_pkh(),
    claimable_balance: 500_000,
  }
  let mutated_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value: assets.from_lovelace(4_000_000)
      |> assets.merge(assets.from_asset(tp, new_member_tn(), 1)),
    datum: InlineDatum(mutated_datum),
    reference_script: None,
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    outputs: [exec_group_output(), mutated_output],
  }
  !call_execute(tx)
}

// ─── Negative: wrong payment credential ────────────────────────────────────────

// Output carries an attacker's PKH instead of request.new_payment_credential.
test execute_recovery__rejects_wrong_payment_credential() {
  let tp = treasury_policy()
  let attacker_pkh = #"abababababababababababababababababababababababababababab00"
  let wrong_cred_datum = TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: new_member_tn(),
    rounds_paid: 2,
    member_payment_credential: attacker_pkh,
    claimable_balance: 500_000,
  }
  let wrong_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value: assets.from_lovelace(4_000_000)
      |> assets.merge(assets.from_asset(tp, new_member_tn(), 1)),
    datum: InlineDatum(wrong_cred_datum),
    reference_script: None,
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    outputs: [exec_group_output(), wrong_output],
  }
  !call_execute(tx)
}

// ─── Negative: N not burned ────────────────────────────────────────────────────

// No mint in the tx — N is not burned, so the old identity persists.
test execute_recovery__rejects_n_not_burned() {
  let tx = Transaction { ..valid_execute_tx(), mint: assets.zero }
  !call_execute(tx)
}

// ─── Negative: wrong token burned ─────────────────────────────────────────────

// N' is burned instead of N — the burn must specifically target the old token name.
test execute_recovery__rejects_wrong_token_burned() {
  let wrong_burn = assets.from_asset(treasury_policy(), new_member_tn(), -1)
  let tx = Transaction { ..valid_execute_tx(), mint: wrong_burn }
  !call_execute(tx)
}

// ─── Negative: output holds wrong identity token ───────────────────────────────

// The rotated output holds N (old identity) instead of N' — the swap is not honoured.
test execute_recovery__rejects_output_wrong_identity() {
  let tp = treasury_policy()
  // Correct datum but wrong VALUE token (N instead of N').
  let rotated_datum = TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: new_member_tn(),
    rounds_paid: 2,
    member_payment_credential: recoveree_pkh(),
    claimable_balance: 500_000,
  }
  let wrong_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value: assets.from_lovelace(4_000_000)
      |> assets.merge(assets.from_asset(tp, target_tn(), 1)),
    datum: InlineDatum(rotated_datum),
    reference_script: None,
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    outputs: [exec_group_output(), wrong_output],
  }
  !call_execute(tx)
}

// ─── Negative: balance skim ─────────────────────────────────────────────────────

// Output ADA is 1 lovelace less than input ADA — economic value must be conserved.
test execute_recovery__rejects_balance_skim() {
  let tp = treasury_policy()
  let rotated_datum = TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: new_member_tn(),
    rounds_paid: 2,
    member_payment_credential: recoveree_pkh(),
    claimable_balance: 500_000,
  }
  let skimmed_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    // 1 lovelace less than the 4_000_000 in exec_member_treasury_input
    value: assets.from_lovelace(3_999_999)
      |> assets.merge(assets.from_asset(tp, new_member_tn(), 1)),
    datum: InlineDatum(rotated_datum),
    reference_script: None,
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    outputs: [exec_group_output(), skimmed_output],
  }
  !call_execute(tx)
}

// ─── Negative: foreign-group member treasury ──────────────────────────────────

// The member treasury UTxO links to a DIFFERENT group (group_reference_tokenname
// does not match the group being spent) — must reject.
test execute_recovery__rejects_foreign_group_member_treasury() {
  let tp = treasury_policy()
  let foreign_group_tn = #"ffffffffffffffffffffffffffffffffffffffffffffffffffffaaaa"
  let foreign_member_datum = TreasuryState {
    group_reference_tokenname: foreign_group_tn,
    member_reference_tokenname: target_tn(),
    rounds_paid: 2,
    member_payment_credential: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    claimable_balance: 500_000,
  }
  let foreign_treasury_input = Input {
    output_reference: exec_member_treasury_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(tp),
        stake_credential: None,
      },
      value: assets.from_lovelace(4_000_000)
        |> assets.merge(assets.from_asset(tp, target_tn(), 1)),
      datum: InlineDatum(foreign_member_datum),
      reference_script: None,
    },
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    inputs: [exec_group_input(), exec_request_input(), foreign_treasury_input],
  }
  !call_execute(tx)
}

// ─── Negative: missing registry swap ──────────────────────────────────────────

// Group output registry still contains N and lacks N' — the swap was not performed.
test execute_recovery__rejects_missing_registry_swap() {
  let gp = group_policy()
  // Group output datum with the OLD registry (N still present, N' absent).
  let unswapped_group_datum = GroupCip68Datum {
    ..exec_group_cip68_datum(),
    extra: GroupDatum {
      ..exec_group_datum(),
      // N (target_tn) still in registry — not swapped
      member_token_names: [target_tn(), approver_a_tn(), approver_b_tn()],
    },
  }
  let unswapped_group_output = Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
    datum: InlineDatum(unswapped_group_datum),
    reference_script: None,
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    outputs: [unswapped_group_output, rotated_treasury_output()],
  }
  !call_execute(tx)
}

// ─── Negative: native-token contribution-balance drain ─────────────────────────
//
// For a native-token group, the rotation must conserve the member's contribution
// tokens exactly. A rotation that keeps ADA + N' but routes the contribution tokens
// out is silent theft from the recovered member.

// A distinct native policy used as the contribution asset (not ADA, not treasury/group/account).
fn contribution_policy() -> assets.PolicyId {
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}

fn contribution_assetname() -> assets.AssetName {
  #"434f4e54524942"
}

// Native-token group: contribution_fee_policyid is a native token policy.
fn native_group_datum() -> GroupDatum {
  GroupDatum {
    ..exec_group_datum(),
    contribution_fee_policyid: contribution_policy(),
    contribution_fee_assetname: contribution_assetname(),
    contribution_fee: 50,
  }
}

fn native_group_cip68_datum() -> GroupCip68Datum {
  GroupCip68Datum {
    metadata: [Pair(#"6e616d65", "Test Group")],
    version: 1,
    extra: native_group_datum(),
  }
}

fn native_group_input() -> Input {
  let gp = group_policy()
  Input {
    output_reference: exec_group_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(gp),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
      datum: InlineDatum(native_group_cip68_datum()),
      reference_script: None,
    },
  }
}

fn native_group_output() -> Output {
  let gp = group_policy()
  let swapped_datum = GroupCip68Datum {
    ..native_group_cip68_datum(),
    extra: GroupDatum {
      ..native_group_datum(),
      member_token_names: [approver_a_tn(), approver_b_tn(), new_member_tn()],
    },
  }
  Output {
    address: Address { payment_credential: Script(gp), stake_credential: None },
    value: assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(gp, group_ref_tn(), 1)),
    datum: InlineDatum(swapped_datum),
    reference_script: None,
  }
}

// Member treasury holding ADA + N + 100 contribution tokens.
fn native_member_treasury_input() -> Input {
  let tp = treasury_policy()
  Input {
    output_reference: exec_member_treasury_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(tp),
        stake_credential: None,
      },
      value: assets.from_lovelace(4_000_000)
        |> assets.merge(assets.from_asset(tp, target_tn(), 1))
        |> assets.merge(
            assets.from_asset(
              contribution_policy(),
              contribution_assetname(),
              100,
            ),
          ),
      datum: InlineDatum(member_treasury_datum()),
      reference_script: None,
    },
  }
}

fn native_rotated_datum() -> TreasuryDatum {
  TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: new_member_tn(),
    rounds_paid: 2,
    member_payment_credential: recoveree_pkh(),
    claimable_balance: 500_000,
  }
}

// Rotated output that DROPS the 100 contribution tokens — the drain.
test execute_recovery__rejects_native_token_drain() {
  let tp = treasury_policy()
  let drained_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    // ADA + N' preserved, contribution tokens GONE (routed out)
    value: assets.from_lovelace(4_000_000)
      |> assets.merge(assets.from_asset(tp, new_member_tn(), 1)),
    datum: InlineDatum(native_rotated_datum()),
    reference_script: None,
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    inputs: [
      native_group_input(),
      exec_request_input(),
      native_member_treasury_input(),
    ],
    outputs: [native_group_output(), drained_output],
  }
  !call_execute(tx)
}

// Control: a native-token rotation that PRESERVES the contribution tokens passes.
test execute_recovery__accepts_native_token_preserved() {
  let tp = treasury_policy()
  let conserved_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value: assets.from_lovelace(4_000_000)
      |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
      |> assets.merge(
          assets.from_asset(
            contribution_policy(),
            contribution_assetname(),
            100,
          ),
        ),
    datum: InlineDatum(native_rotated_datum()),
    reference_script: None,
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    inputs: [
      native_group_input(),
      exec_request_input(),
      native_member_treasury_input(),
    ],
    outputs: [native_group_output(), conserved_output],
  }
  call_execute(tx)
}

// ─── Negative: group output at wrong address ──────────────────────────────────
//
// The group output carries the correct (swapped) datum but sits at a VK wallet
// address instead of the group script — the treasury side must reject this without
// relying on RecoverMember. Enforced via `expect` (hard crash), so `fail`-style.
test execute_recovery__rejects_group_output_at_wrong_address() fail {
  let swapped_datum = GroupCip68Datum {
    ..exec_group_cip68_datum(),
    extra: GroupDatum {
      ..exec_group_datum(),
      member_token_names: [approver_a_tn(), approver_b_tn(), new_member_tn()],
    },
  }
  let wrong_addr_group_output = Output {
    // VK wallet address, not the group script
    address: Address {
      payment_credential: VerificationKey(common.test_pkh()),
      stake_credential: None,
    },
    value: assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(group_policy(), group_ref_tn(), 1)),
    datum: InlineDatum(swapped_datum),
    reference_script: None,
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    outputs: [wrong_addr_group_output, rotated_treasury_output()],
  }
  call_execute(tx)
}

// ─── Negative: claimable_balance zeroed ───────────────────────────────────────
//
// Explicit high-value economic-field test: input claimable_balance 500_000 is
// zeroed in the rotated output — the recovered member loses their earmarked payout.
test execute_recovery__rejects_claimable_balance_zeroed() {
  let tp = treasury_policy()
  let zeroed_datum = TreasuryState {
    group_reference_tokenname: group_ref_tn(),
    member_reference_tokenname: new_member_tn(),
    rounds_paid: 2,
    member_payment_credential: recoveree_pkh(),
    // claimable_balance zeroed — NOT allowed; the earmark must carry through
    claimable_balance: 0,
  }
  let zeroed_output = Output {
    address: Address { payment_credential: Script(tp), stake_credential: None },
    value: assets.from_lovelace(4_000_000)
      |> assets.merge(assets.from_asset(tp, new_member_tn(), 1)),
    datum: InlineDatum(zeroed_datum),
    reference_script: None,
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    outputs: [exec_group_output(), zeroed_output],
  }
  !call_execute(tx)
}

// ─── AIK-4 stake-credential drain negative tests ────────────────────────────
//
// Attacker puts a stake key on a continuation recovery output. The full-address
// equality check must reject it even when payment credential and datum are correct.

fn attacker_pkh() -> ByteArray {
  #"ababababababababababababababababababababababababababababababab"
}

fn attacker_stake_address(payment: assets.PolicyId) -> Address {
  Address {
    payment_credential: Script(payment),
    stake_credential: Some(Inline(VerificationKey(attacker_pkh()))),
  }
}

// ─── ApproveRecovery: attacker stake key on the continuing request output ─────
test approve_recovery__rejects_request_output_stake_credential_change() {
  let tp = treasury_policy()
  let existing_approvals = [approver_a_tn()]
  let updated_approvals = [approver_a_tn(), approver_b_tn()]

  // Same datum and value as a valid approve, but at attacker's staked address
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
  let attacker_output = Output {
    address: attacker_stake_address(tp),
    value,
    datum: InlineDatum(approve_request_datum(updated_approvals)),
    reference_script: None,
  }

  let request_in = request_input_utxo(approve_request_datum(existing_approvals))
  let approver_b = approver_b_input()
  let group_ref = test_group_input()
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [request_in, approver_b],
    reference_inputs: [group_ref],
    outputs: [attacker_output],
    mint: assets.zero,
    extra_signatories: [approver_b_pkh()],
    validity_range: interval.after(0),
  }

  !call_approve(tx)
}

// ─── ExecuteRecovery: attacker stake key on the rotated treasury output ───────
test execute_recovery__rejects_rotated_output_stake_credential_change() {
  let tp = treasury_policy()
  // Same value and datum as the valid rotated output, but at attacker's staked address
  let value = assets.from_lovelace(4_000_000)
    |> assets.merge(assets.from_asset(tp, new_member_tn(), 1))
  let attacker_output = Output {
    address: attacker_stake_address(tp),
    value,
    datum: InlineDatum(
      TreasuryState {
        group_reference_tokenname: group_ref_tn(),
        member_reference_tokenname: new_member_tn(),
        rounds_paid: 2,
        member_payment_credential: recoveree_pkh(),
        claimable_balance: 500_000,
      },
    ),
    reference_script: None,
  }
  let tx = Transaction {
    ..valid_execute_tx(),
    outputs: [exec_group_output(), attacker_output],
  }
  !call_execute(tx)
}

// ─── Recovery runner (treasury split — spec 2026-07-04 section 4/5) ───────────

fn runner_settings() -> settings.ProtocolSettings {
  settings.ProtocolSettings {
    account_policy: account_policy(),
    group_policy: group_policy(),
    treasury_policy: treasury_policy(),
    treasury_rounds_stake: common.test_hash_04(),
    treasury_lifecycle_stake: common.test_hash_05(),
    treasury_recovery_stake: common.test_hash_06(),
    treasury_reserve_stake: common.test_hash_07(),
  }
}

// Mirror of propose_recovery__accepts_valid through the runner — a ProposeAction
// covers no treasury input (it CREATES the request UTxO).
test recovery_runner__accepts_valid_propose() {
  run_recovery_action(
    treasury_actions.ProposeAction {
      covered_inputs: [],
      group_ref_input_index: 0,
      request_output_index: 0,
      approver_input_indices: [1],
    },
    runner_settings(),
    valid_tx(),
  )
}

// [security]: a ProposeAction claiming coverage would exempt an unrelated
// treasury spend from validation.
test recovery_runner__rejects_propose_claiming_coverage() fail {
  run_recovery_action(
    treasury_actions.ProposeAction {
      covered_inputs: [0],
      group_ref_input_index: 0,
      request_output_index: 0,
      approver_input_indices: [1],
    },
    runner_settings(),
    valid_tx(),
  )
}

// [security]: an ExecuteAction must cover BOTH spent treasury UTxOs (request +
// lost member) — single coverage would leave one unvalidated.
test recovery_runner__rejects_execute_single_coverage() fail {
  run_recovery_action(
    treasury_actions.ExecuteAction {
      covered_inputs: [0],
      group_ref_input_index: 0,
      group_output_index: 0,
      member_treasury_output_index: 0,
    },
    runner_settings(),
    valid_tx(),
  )
}

test recovery_runner__rejects_approve_empty_coverage() fail {
  run_recovery_action(
    treasury_actions.ApproveAction {
      covered_inputs: [],
      group_ref_input_index: 0,
      request_output_index: 0,
      approver_input_index: 0,
    },
    runner_settings(),
    transaction.placeholder,
  )
}

test recovery_runner__rejects_cancel_empty_coverage() fail {
  run_recovery_action(
    treasury_actions.CancelAction { covered_inputs: [] },
    runner_settings(),
    transaction.placeholder,
  )
}

test recovery_runner__rejects_execute_empty_coverage() fail {
  run_recovery_action(
    treasury_actions.ExecuteAction {
      covered_inputs: [],
      group_ref_input_index: 0,
      group_output_index: 0,
      member_treasury_output_index: 0,
    },
    runner_settings(),
    transaction.placeholder,
  )
}
