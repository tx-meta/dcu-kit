use aiken/interval
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use dcu/group.{GroupCip68Datum, GroupDatum, Push}
use dcu/treasury.{RecoveryRequest, TreasuryDatum}
use dcu/treasury_validation.{validate_propose_recovery}
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
    creator_payment_credential: common.test_pkh(),
    member_token_names: [target_tn(), approver_a_tn(), approver_b_tn()],
    collateral_rounds: 1,
    payout_mode: Push,
    recovery_threshold: 1,
    recovery_timelock: 259_200_000,
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
fn test_recovery_request_datum(approvals: List<assets.AssetName>) -> TreasuryDatum {
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

// Builds a baseline valid ProposeRecovery transaction: group ref input at index 0,
// recoveree + approver_a signed inputs, request output at index 0. validity_range
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
    inputs: [group_input, recoveree, approver_a],
    outputs: [request_output],
    mint: assets.from_asset(treasury_policy(), new_member_tn(), 1),
    extra_signatories: [recoveree_pkh(), approver_a_pkh()],
    validity_range: interval.after(0),
  }
}

// ─── propose_recovery__accepts_valid ──────────────────────────────────────────

test propose_recovery__accepts_valid() {
  let tx = valid_tx()

  // group_ref_input_index=0, request_output_index=0, approver_input_indices=[2]
  validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [2],
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

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, approver_a, approver_b],
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
    [2, 3],
    tx,
  )
}

// ─── Negative: trust / membership ─────────────────────────────────────────────

test propose_recovery__rejects_target_not_in_registry() {
  let group_input = test_group_input()
  let recoveree = recoveree_input()
  let approver_a = approver_a_input()

  let approvals = [approver_a_tn()]
  let datum =
    RecoveryRequest {
      group_reference_tokenname: group_ref_tn(),
      target_token: non_member_tn(),
      new_member_tokenname: new_member_tn(),
      new_payment_credential: recoveree_pkh(),
      earliest_execution_slot: 259_200_000,
      approvals,
    }
  let request_output = test_request_output(datum)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, approver_a],
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
    [2],
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
  let datum =
    RecoveryRequest {
      group_reference_tokenname: group_ref_tn(),
      target_token: target_tn(),
      new_member_tokenname: approver_b_tn(),
      new_payment_credential: recoveree_pkh(),
      earliest_execution_slot: 259_200_000,
      approvals,
    }
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(assets.from_asset(treasury_policy(), approver_b_tn(), 1))
  let request_output =
    Output {
      address: Address {
        payment_credential: Script(treasury_policy()),
        stake_credential: None,
      },
      value,
      datum: InlineDatum(datum),
      reference_script: None,
    }

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, approver_a],
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
    [2],
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

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, approver_a],
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
    [2],
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

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, approver_a],
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
    [2],
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

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, non_member_input],
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
    [2],
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

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, approver_a],
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
    [2, 2],
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

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, target_as_approver],
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
    [2],
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
  let datum =
    RecoveryRequest {
      group_reference_tokenname: group_ref_tn(),
      target_token: target_tn(),
      new_member_tokenname: new_member_tn(),
      new_payment_credential: recoveree_pkh(),
      // Should be 259_200_000 (0 + recovery_timelock); shortened here
      earliest_execution_slot: 1,
      approvals,
    }
  let request_output = test_request_output(datum)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, approver_a],
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
    [2],
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
  let datum =
    RecoveryRequest {
      group_reference_tokenname: group_ref_tn(),
      target_token: target_tn(),
      new_member_tokenname: new_member_tn(),
      // Recoveree controls N' and signs, but the payout address is the attacker's
      new_payment_credential: attacker_pkh,
      earliest_execution_slot: 259_200_000,
      approvals,
    }
  let request_output = test_request_output(datum)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, approver_a],
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
    [2],
    tx,
  )
}

// ─── Negative: mint discipline ────────────────────────────────────────────────

test propose_recovery__rejects_extra_mint() {
  let tx = valid_tx()
  let extra_mint =
    assets.from_asset(treasury_policy(), new_member_tn(), 1)
      |> assets.merge(assets.from_asset(treasury_policy(), non_member_tn(), 1))
  let bad_tx = Transaction { ..tx, mint: extra_mint }

  !validate_propose_recovery(
    treasury_policy(),
    account_policy(),
    group_policy(),
    0,
    0,
    [2],
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
    [2],
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
  let request_output =
    Output {
      address: Address {
        payment_credential: VerificationKey(common.test_pkh()),
        stake_credential: None,
      },
      value,
      datum: InlineDatum(datum),
      reference_script: None,
    }

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, approver_a],
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
    [2],
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

  // Datum claims TWO approvals; only one (approver_a, index 2) is actually
  // verified by approver_input_indices below.
  let inflated_approvals = [approver_a_tn(), approver_b_tn()]
  let request_output = test_request_output(
    test_recovery_request_datum(inflated_approvals),
  )

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, approver_a],
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
    [2],
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

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [group_input, recoveree, approver_a],
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
    [2],
    tx,
  )
}
