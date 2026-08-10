// ADR-0003 two-family split — the negative-test matrix and the wiring
// regression. Every row here must FAIL except the two marked otherwise (I9 and
// the P1 happy paths).
//
// This module lives under validators/ because Aiken forbids a library module
// from importing a validator; the fixtures it uses are in lib/tests/split_common.
//
// Row-to-test map (docs/adr/0003):
//
//   Family routing  R1 R2 R3 R4 R5 R6 R7 R8 R9
//   Coverage        C1 C2 C3 C4 C5 C6 C7
//   Intent          I1 I2 I3 I4 I5 I6 I7 I8 I9(pass) I10
//   Mint and burn   M1 M2 M3 M4 M5
//   Regression      P1 (twelve happy paths, here)
//                   P2 P3 P4 (lib/tests/intent_vectors, vault_spend, vault_loans
//                             — unchanged by the split)
//                   P5 P6 (emulator, sdk/test/savings*.test.ts)
use aiken/builtin
use cardano/address as addr
use cardano/assets
use savings/types.{
  Current, SavingsDirectAction, SavingsMintRedeemer, SavingsSpendRedeemer,
}
use savings/validation.{
  datum_intent_hash, social_payout_intent_hash, update_fund_intent_hash,
  write_off_intent_hash,
}
use savings_direct
use savings_governed
use savings_vault_validator
use tests/common.{
  fund_name, make_loan, member_address, policy, quorum_pkh, user_token_input,
}
use tests/split_common.{
  claim_share_out_tx, close_cycle_tx, close_fund_intent, close_fund_tx,
  dep_fund_input, dep_member_input, dep_outputs, deposit_action, deposit_tx,
  direct_cred, direct_pair, disburse_intent, disburse_tx, disburse_tx_with,
  foreign_input, foreign_pair, governed_cred, governed_pair, mark_arrears_tx,
  payout_amount, remove_account_tx, repay_tx, social_payout_action,
  social_payout_tx, social_payout_tx_with, sp_fund_input, spend_pair,
  stray_vault_input, uf_intent, update_fund_action, update_fund_tx,
  update_fund_tx_with, with_inputs, with_redeemers, with_withdrawals,
  withdraw_tx, write_off_intent, write_off_tx, write_off_tx_with,
}
use tests/split_common as fx

fn gov() {
  fx.governed_hash()
}

fn dir() {
  fx.direct_hash()
}

/// The vault's thin spend handler, under the real family parameters.
fn vault_spend(datum, redeemer, utxo, tx) {
  savings_vault_validator.savings_vault.spend(
    gov(),
    dir(),
    Some(datum),
    redeemer,
    utxo,
    tx,
  )
}

fn vault_mint(redeemer: SavingsMintRedeemer, tx) {
  savings_vault_validator.savings_vault.mint(
    gov(),
    dir(),
    redeemer,
    policy(),
    tx,
  )
}

fn other_address() {
  addr.from_verification_key(quorum_pkh())
}

// ── R: family routing ───────────────────────────────────────────────────────

// R1 — a governed operation presented with the savings_direct withdrawal. The
// vault routes SocialPayout to the governed credential, which is absent.
test r1__governed_op_with_direct_withdrawal() {
  let tx = with_withdrawals(
    with_redeemers(
      social_payout_tx(),
      [
        spend_pair(
          sp_fund_input(),
          SavingsSpendRedeemer.SocialPayout { intent_hash: fx.sp_intent() },
        ),
        direct_pair(deposit_action([0])),
      ],
    ),
    [Pair(direct_cred(), 0)],
  )
  !vault_spend(
    fx.sp_fund_datum(),
    SavingsSpendRedeemer.SocialPayout { intent_hash: fx.sp_intent() },
    sp_fund_input().output_reference,
    tx,
  )
}

// R2 — a direct operation presented with the savings_governed withdrawal.
test r2__direct_op_with_governed_withdrawal() {
  let tx = with_withdrawals(
    with_redeemers(
      deposit_tx(),
      [
        spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit),
        governed_pair(social_payout_action([0, 1])),
      ],
    ),
    [Pair(governed_cred(), 0)],
  )
  !vault_spend(
    fx.active_fund_zero(),
    SavingsSpendRedeemer.Deposit,
    dep_fund_input().output_reference,
    tx,
  )
}

// R3 — no family withdrawal in the transaction at all.
test r3__no_family_withdrawal() {
  let tx = with_withdrawals(
    with_redeemers(
      deposit_tx(),
      [spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit)],
    ),
    [],
  )
  !vault_spend(
    fx.active_fund_zero(),
    SavingsSpendRedeemer.Deposit,
    dep_fund_input().output_reference,
    tx,
  )
}

// R4 — the family withdrawal is present but its covered set does not name this
// spending input (the pin rule: presence alone is not enough).
test r4__withdrawal_not_covering_this_input() {
  let tx = with_redeemers(
    deposit_tx(),
    [
      spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit),
      spend_pair(dep_member_input(), SavingsSpendRedeemer.Deposit),
      direct_pair(deposit_action([1])),
    ],
  )
  !vault_spend(
    fx.active_fund_zero(),
    SavingsSpendRedeemer.Deposit,
    dep_fund_input().output_reference,
    tx,
  )
}

// R5 — a withdrawal from a foreign script credential carrying a well-formed
// family action. The vault looks the family up by its parameterized hash, so a
// lookalike credential is simply not found.
test r5__foreign_credential_resembling_a_family() {
  let tx = with_withdrawals(
    with_redeemers(
      deposit_tx(),
      [
        spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit),
        spend_pair(dep_member_input(), SavingsSpendRedeemer.Deposit),
        foreign_pair(deposit_action([0, 1])),
      ],
    ),
    [Pair(addr.Script(fx.foreign_hash()), 0)],
  )
  !vault_spend(
    fx.active_fund_zero(),
    SavingsSpendRedeemer.Deposit,
    dep_fund_input().output_reference,
    tx,
  )
}

// R6 — the family withdrawal moves a non-zero amount. Withdraw-zero means zero:
// a rewarded withdrawal is a different transaction shape than the one audited.
test r6__non_zero_withdrawal() fail {
  savings_direct.savings_direct.withdraw(
    deposit_action([0, 1]),
    direct_cred(),
    with_withdrawals(deposit_tx(), [Pair(direct_cred(), 1)]),
  )
}

// R7 — the anchor runs Deposit, but the member satellite is spent with a
// DIFFERENT direct-family constructor. The economic Deposit transition would
// still validate, so nothing but the per-input tag binding rejects this: the
// redeemer sitting on that input must describe the operation that ran.
test r7__satellite_with_another_direct_constructor() {
  let tx = with_redeemers(
    deposit_tx(),
    [
      spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit),
      spend_pair(dep_member_input(), SavingsSpendRedeemer.MarkArrears),
      direct_pair(deposit_action([0, 1])),
    ],
  )
  and {
    // the anchor still binds — the mismatch is on the satellite alone
    vault_spend(
      fx.active_fund_zero(),
      SavingsSpendRedeemer.Deposit,
      dep_fund_input().output_reference,
      tx,
    ),
    !vault_spend(
      fx.zero_member(),
      SavingsSpendRedeemer.MarkArrears,
      dep_member_input().output_reference,
      tx,
    ),
  }
}

// R8 — the satellite is spent with a GOVERNED constructor carrying its own
// commitment while the anchor runs a direct operation. Routing sends it to the
// governed family, which is not withdrawing here.
test r8__satellite_with_a_governed_constructor() {
  let tx = with_redeemers(
    deposit_tx(),
    [
      spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit),
      spend_pair(
        dep_member_input(),
        SavingsSpendRedeemer.CloseFund { intent_hash: close_fund_intent() },
      ),
      direct_pair(deposit_action([0, 1])),
    ],
  )
  !vault_spend(
    fx.zero_member(),
    SavingsSpendRedeemer.CloseFund { intent_hash: close_fund_intent() },
    dep_member_input().output_reference,
    tx,
  )
}

// R9 — a governed operation's satellite spent under a different GOVERNED
// constructor. Both route to the governed family and its withdrawal is present,
// so only the action-tag half of the binding rejects this one.
test r9__governed_satellite_with_another_governed_constructor() {
  let tx = with_redeemers(
    disburse_tx(),
    [
      spend_pair(
        fx.disburse_anchor(),
        SavingsSpendRedeemer.DisburseLoan { intent_hash: disburse_intent() },
      ),
      spend_pair(
        fx.disburse_member(),
        SavingsSpendRedeemer.WriteOffLoan { intent_hash: disburse_intent() },
      ),
      governed_pair(fx.disburse_action()),
    ],
  )
  !vault_spend(
    fx.disburse_member_datum(),
    SavingsSpendRedeemer.WriteOffLoan { intent_hash: disburse_intent() },
    fx.disburse_member().output_reference,
    tx,
  )
}

// ── C: coverage ─────────────────────────────────────────────────────────────

// C1 — the anchor is consumed but only the satellite is covered.
test c1__anchor_consumed_not_covered() fail {
  savings_direct.savings_direct.withdraw(
    deposit_action([1]),
    direct_cred(),
    with_redeemers(
      deposit_tx(),
      [
        spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit),
        spend_pair(dep_member_input(), SavingsSpendRedeemer.Deposit),
        direct_pair(deposit_action([1])),
      ],
    ),
  )
}

// C2 — the satellite (member account) is consumed but only the anchor is
// covered. Without this, a second vault UTxO rides through unvalidated.
test c2__satellite_consumed_not_covered() fail {
  savings_direct.savings_direct.withdraw(
    deposit_action([0]),
    direct_cred(),
    with_redeemers(
      deposit_tx(),
      [
        spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit),
        spend_pair(dep_member_input(), SavingsSpendRedeemer.Deposit),
        direct_pair(deposit_action([0])),
      ],
    ),
  )
}

// C3 — the same input covered twice, padding the count to hide an uncovered one.
test c3__same_input_covered_twice() fail {
  savings_direct.savings_direct.withdraw(
    deposit_action([0, 0]),
    direct_cred(),
    with_redeemers(
      deposit_tx(),
      [
        spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit),
        spend_pair(dep_member_input(), SavingsSpendRedeemer.Deposit),
        direct_pair(deposit_action([0, 0])),
      ],
    ),
  )
}

// C4 — coverage naming an input the transaction does not consume.
test c4__covers_absent_input() fail {
  savings_direct.savings_direct.withdraw(
    deposit_action([0, 9]),
    direct_cred(),
    with_redeemers(
      deposit_tx(),
      [
        spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit),
        spend_pair(dep_member_input(), SavingsSpendRedeemer.Deposit),
        direct_pair(deposit_action([0, 9])),
      ],
    ),
  )
}

// C5 — coverage naming a foreign-script input, so the derived policy would not
// be the vault's.
test c5__covers_foreign_script_input() fail {
  let inputs = [dep_fund_input(), foreign_input(7), user_token_input()]
  savings_direct.savings_direct.withdraw(
    deposit_action([0, 1]),
    direct_cred(),
    with_inputs(deposit_tx(), inputs),
  )
}

// C6 — two savings operations batched under one withdrawal: four vault inputs
// consumed, one two-input action covering half of them.
test c6__two_operations_batched() fail {
  let inputs = [
    dep_fund_input(),
    dep_member_input(),
    stray_vault_input(5),
    stray_vault_input(6),
    user_token_input(),
  ]
  savings_direct.savings_direct.withdraw(
    deposit_action([0, 1]),
    direct_cred(),
    with_inputs(deposit_tx(), inputs),
  )
}

// C7 — two withdrawals of the same family in one transaction.
test c7__duplicate_family_withdrawal() fail {
  savings_direct.savings_direct.withdraw(
    deposit_action([0, 1]),
    direct_cred(),
    with_withdrawals(
      deposit_tx(),
      [Pair(direct_cred(), 0), Pair(direct_cred(), 0)],
    ),
  )
}

// ── I: intent (governed family only) ────────────────────────────────────────

// I1 — a commitment that is correct, but for a different operation's payload.
test i1__intent_of_another_operation() {
  !savings_governed.savings_governed.withdraw(
    social_payout_action([0]),
    governed_cred(),
    social_payout_tx_with(uf_intent()),
  )
}

// I2 — right shape, wrong recipient.
test i2__intent_wrong_recipient() {
  !savings_governed.savings_governed.withdraw(
    social_payout_action([0]),
    governed_cred(),
    social_payout_tx_with(
      social_payout_intent_hash(other_address(), payout_amount()),
    ),
  )
}

// I3a — wrong amount.
test i3a__intent_wrong_amount() {
  !savings_governed.savings_governed.withdraw(
    social_payout_action([0]),
    governed_cred(),
    social_payout_tx_with(
      social_payout_intent_hash(member_address(), payout_amount() + 1),
    ),
  )
}

// I3b — wrong principal, charge and due date: the commitment covers the whole
// loan datum, so any term substitution breaks it.
test i3b__intent_wrong_loan_terms() {
  !savings_governed.savings_governed.withdraw(
    fx.disburse_action(),
    governed_cred(),
    disburse_tx_with(datum_intent_hash(make_loan(7_000_000, 0, Current))),
  )
}

// I4 — wrong loan id: the write-off commitment is the loan's state-token name.
test i4__intent_wrong_loan_id() {
  !savings_governed.savings_governed.withdraw(
    fx.write_off_action(),
    governed_cred(),
    write_off_tx_with(write_off_intent_hash(fund_name())),
  )
}

// I5 — correct parameter shape computed against a different fund's charter.
test i5__intent_of_another_fund() {
  !savings_governed.savings_governed.withdraw(
    update_fund_action([0]),
    governed_cred(),
    update_fund_tx_with(
      SavingsSpendRedeemer.UpdateFund {
        intent_hash: update_fund_intent_hash(
          #"4f746865722046756e64",
          addr.VerificationKey(quorum_pkh()),
          2,
          50,
          1,
          604_800_000,
          None,
        ),
      },
    ),
  )
}

// I6a — an empty commitment.
test i6a__empty_commitment() {
  !savings_governed.savings_governed.withdraw(
    social_payout_action([0]),
    governed_cred(),
    social_payout_tx_with(""),
  )
}

// I6b — a commitment that is not 32 bytes.
test i6b__short_commitment() {
  !savings_governed.savings_governed.withdraw(
    social_payout_action([0]),
    governed_cred(),
    social_payout_tx_with(#"01"),
  )
}

// I7 — the commitment moved to the withdrawal redeemer instead of field 0 of
// the spending redeemer. The spend redeemer keeps the right constructor tag but
// carries no fields, so there is no field 0 to read: the ADR-0002 ABI is gone
// and the governed operation must not execute. This is the row that a field-less
// spend redeemer (the literal treasury pattern) would silently turn green.
test i7__commitment_not_at_spend_field_0() fail {
  let field_less: Data = builtin.constr_data(2, [])
  savings_governed.savings_governed.withdraw(
    social_payout_action([0]),
    governed_cred(),
    with_redeemers(
      social_payout_tx(),
      [
        Pair(fx.spend_purpose(sp_fund_input()), field_less),
        governed_pair(social_payout_action([0])),
      ],
    ),
  )
}

// I8 — the constructor tag changed while the commitment is preserved, so a
// decision ratified for one operation cannot be executed as another.
test i8__constructor_tag_changed() fail {
  let intent: Data = fx.sp_intent()
  let wrong_tag: Data = builtin.constr_data(3, [intent])
  savings_governed.savings_governed.withdraw(
    social_payout_action([0]),
    governed_cred(),
    with_redeemers(
      social_payout_tx(),
      [
        Pair(fx.spend_purpose(sp_fund_input()), wrong_tag),
        governed_pair(social_payout_action([0])),
      ],
    ),
  )
}

// I9 — MUST PASS. Reordering transaction inputs and outputs while preserving
// the semantics stays valid: the action's indices are re-resolved, nothing is
// bound to a position.
test i9__reordered_indices_still_valid() {
  let inputs = [user_token_input(), dep_member_input(), dep_fund_input()]
  let outputs = when dep_outputs() is {
    [fund_out, member_out] -> [member_out, fund_out]
    _ -> fail @"deposit fixture shape changed"
  }
  let reordered = SavingsDirectAction.DepositAction {
    covered_inputs: [2, 1],
    fund_input_index: 2,
    member_input_index: 1,
    fund_output_index: 1,
    member_output_index: 0,
    fund_tag: 0,
  }
  let tx = with_redeemers(
    fx.make_tx(inputs, outputs, assets.zero, [], [Pair(direct_cred(), 0)], []),
    [
      spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit),
      spend_pair(dep_member_input(), SavingsSpendRedeemer.Deposit),
      direct_pair(reordered),
    ],
  )
  and {
    savings_direct.savings_direct.withdraw(reordered, direct_cred(), tx),
    vault_spend(
      fx.active_fund_zero(),
      SavingsSpendRedeemer.Deposit,
      dep_fund_input().output_reference,
      tx,
    ),
  }
}

// I10 — the committed intent is well formed, but the transition it produces is
// not the one committed: the payout output pays the intent's amount while the
// fund releases more.
test i10__transition_does_not_match_intent() {
  let drained = fx.social_payout_tx_drained(
    social_payout_intent_hash(member_address(), payout_amount()),
  )
  !savings_governed.savings_governed.withdraw(
    social_payout_action([0]),
    governed_cred(),
    drained,
  )
}

// ── M: mint and burn coupling ───────────────────────────────────────────────

// M1 — a loan NFT minted without the DisburseLoan family transition.
test m1__loan_mint_without_disbursement() {
  let tx = with_redeemers(
    disburse_tx(),
    [
      spend_pair(
        fx.disburse_anchor(),
        SavingsSpendRedeemer.DisburseLoan { intent_hash: disburse_intent() },
      ),
      governed_pair(fx.close_fund_action()),
    ],
  )
  !vault_mint(SavingsMintRedeemer.MintLoan { seed_input_index: 3 }, tx)
}

test m1__loan_mint_accepts_disbursement() {
  vault_mint(
    SavingsMintRedeemer.MintLoan { seed_input_index: 3 },
    disburse_tx(),
  )
}

// M2 — a loan NFT burned with neither RepayLoan nor WriteOffLoan running.
test m2__loan_burn_without_closure() {
  let tx = with_redeemers(
    write_off_tx(),
    [
      spend_pair(
        fx.write_off_anchor(),
        SavingsSpendRedeemer.WriteOffLoan { intent_hash: write_off_intent() },
      ),
      governed_pair(social_payout_action([0])),
    ],
  )
  !vault_mint(SavingsMintRedeemer.BurnLoan, tx)
}

test m2__loan_burn_accepts_write_off() {
  vault_mint(SavingsMintRedeemer.BurnLoan, write_off_tx())
}

// M3 — a member's CIP-68 pair burned without RemoveAccount running.
test m3__account_burn_without_removal() {
  let tx = with_redeemers(
    remove_account_tx(),
    [
      spend_pair(fx.remove_member_input(), SavingsSpendRedeemer.RemoveAccount),
      direct_pair(deposit_action([0])),
    ],
  )
  !vault_mint(SavingsMintRedeemer.BurnAccount, tx)
}

test m3__account_burn_accepts_removal() {
  vault_mint(SavingsMintRedeemer.BurnAccount, remove_account_tx())
}

// M4 — the Fund State NFT burned without CloseFund running.
test m4__fund_burn_without_closure() {
  let tx = with_redeemers(
    close_fund_tx(),
    [
      spend_pair(
        fx.close_fund_anchor(),
        SavingsSpendRedeemer.CloseFund { intent_hash: close_fund_intent() },
      ),
      governed_pair(social_payout_action([0])),
    ],
  )
  !vault_mint(SavingsMintRedeemer.BurnFund, tx)
}

test m4__fund_burn_accepts_closure() {
  vault_mint(SavingsMintRedeemer.BurnFund, close_fund_tx())
}

// M5a — an account burn attributed to the GOVERNED family. Tag 5 is
// RemoveAccountAction in the direct family and CloseFundAction in the governed
// one; without the family check the tag alone would license this burn.
test m5a__account_burn_attributed_to_governed() {
  let tx = with_withdrawals(
    with_redeemers(
      remove_account_tx(),
      [
        spend_pair(fx.remove_member_input(), SavingsSpendRedeemer.RemoveAccount),
        governed_pair(fx.close_fund_action()),
      ],
    ),
    [Pair(governed_cred(), 0)],
  )
  !vault_mint(SavingsMintRedeemer.BurnAccount, tx)
}

// M5b — a fund burn attributed to the DIRECT family, the mirror case.
test m5b__fund_burn_attributed_to_direct() {
  let tx = with_withdrawals(
    with_redeemers(
      close_fund_tx(),
      [
        spend_pair(
          fx.close_fund_anchor(),
          SavingsSpendRedeemer.CloseFund { intent_hash: close_fund_intent() },
        ),
        direct_pair(fx.remove_account_action()),
      ],
    ),
    [Pair(direct_cred(), 0)],
  )
  !vault_mint(SavingsMintRedeemer.BurnFund, tx)
}

// M5c — a loan burn licensed by the governed DISBURSE tag rather than a closure.
test m5c__loan_burn_attributed_to_disbursement() {
  let tx = with_redeemers(
    write_off_tx(),
    [
      spend_pair(
        fx.write_off_anchor(),
        SavingsSpendRedeemer.WriteOffLoan { intent_hash: write_off_intent() },
      ),
      governed_pair(fx.disburse_action()),
    ],
  )
  !vault_mint(SavingsMintRedeemer.BurnLoan, tx)
}

// ── P1: all twelve operations succeed through the family handlers ───────────

test p1_01__deposit() {
  and {
    savings_direct.savings_direct.withdraw(
      deposit_action([0, 1]),
      direct_cred(),
      deposit_tx(),
    ),
    vault_spend(
      fx.active_fund_zero(),
      SavingsSpendRedeemer.Deposit,
      dep_fund_input().output_reference,
      deposit_tx(),
    ),
    vault_spend(
      fx.zero_member(),
      SavingsSpendRedeemer.Deposit,
      dep_member_input().output_reference,
      deposit_tx(),
    ),
  }
}

test p1_02__withdraw() {
  savings_direct.savings_direct.withdraw(
    fx.withdraw_action(),
    direct_cred(),
    withdraw_tx(),
  )
}

test p1_03__claim_share_out() {
  savings_direct.savings_direct.withdraw(
    fx.claim_action(),
    direct_cred(),
    claim_share_out_tx(),
  )
}

test p1_04__repay_loan() {
  savings_direct.savings_direct.withdraw(
    fx.repay_action(),
    direct_cred(),
    repay_tx(),
  )
}

test p1_05__mark_arrears() {
  savings_direct.savings_direct.withdraw(
    fx.mark_arrears_action(),
    direct_cred(),
    mark_arrears_tx(),
  )
}

test p1_06__remove_account() {
  savings_direct.savings_direct.withdraw(
    fx.remove_account_action(),
    direct_cred(),
    remove_account_tx(),
  )
}

test p1_07__social_payout() {
  and {
    savings_governed.savings_governed.withdraw(
      social_payout_action([0]),
      governed_cred(),
      social_payout_tx(),
    ),
    vault_spend(
      fx.sp_fund_datum(),
      SavingsSpendRedeemer.SocialPayout { intent_hash: fx.sp_intent() },
      sp_fund_input().output_reference,
      social_payout_tx(),
    ),
  }
}

test p1_08__update_fund() {
  savings_governed.savings_governed.withdraw(
    update_fund_action([0]),
    governed_cred(),
    update_fund_tx(),
  )
}

test p1_09__close_cycle() {
  savings_governed.savings_governed.withdraw(
    fx.close_cycle_action(),
    governed_cred(),
    close_cycle_tx(),
  )
}

test p1_10__disburse_loan() {
  savings_governed.savings_governed.withdraw(
    fx.disburse_action(),
    governed_cred(),
    disburse_tx(),
  )
}

test p1_11__write_off_loan() {
  savings_governed.savings_governed.withdraw(
    fx.write_off_action(),
    governed_cred(),
    write_off_tx(),
  )
}

test p1_12__close_fund() {
  savings_governed.savings_governed.withdraw(
    fx.close_fund_action(),
    governed_cred(),
    close_fund_tx(),
  )
}
