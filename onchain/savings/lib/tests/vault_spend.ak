use cardano/assets
use cardano/transaction.{Input}
use savings/types.{Active, MemberAccount, SavingsDatum, SavingsFund, SharingOut}
use savings/validation.{
  validate_claim_share_out, validate_close_cycle, validate_close_fund,
  validate_deposit, validate_paired_member, validate_remove_account,
  validate_social_payout, validate_update_fund, validate_withdraw,
}
use tests/common.{
  anchor_value, fund_name, make_fund, make_member, member_ref_value, policy,
  quorum_tx, ref_name, unsigned_tx, user_name, user_token_input, vault_input,
  vault_output,
}

// Standing fixture: ADA fund, 15 shares total (this member holds 10),
// social 3 ADA, 2 ADA untagged top-up → vault = 2 buffer + 15 + 3 + 2 = 22.
fn f0() -> SavingsDatum {
  make_fund(0, 15, 15_000_000, 3_000_000, Active)
}

fn anchor_in(datum: SavingsDatum, lovelace: Int) -> Input {
  vault_input(0, vault_output(datum, anchor_value(lovelace)))
}

fn member_in(units: Int, social: Int) -> Input {
  vault_input(1, vault_output(make_member(units, social), member_ref_value()))
}

fn no_mint() {
  assets.zero
}

// ── Deposit ─────────────────────────────────────────────────────────────────

test deposit__accepts_share_purchase() {
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let fund_out = vault_output(
    make_fund(0, 20, 20_000_000, 3_000_000, Active),
    anchor_value(27_000_000),
  )
  let member_out = vault_output(make_member(15, 3_000_000), member_ref_value())
  validate_deposit(
    policy(),
    f0(),
    a,
    1,
    0,
    1,
    0,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test deposit__accepts_social_contribution() {
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let fund_out = vault_output(
    make_fund(0, 15, 15_000_000, 4_000_000, Active),
    anchor_value(23_000_000),
  )
  let member_out = vault_output(make_member(10, 4_000_000), member_ref_value())
  validate_deposit(
    policy(),
    f0(),
    a,
    1,
    0,
    1,
    1,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test deposit__accepts_untagged_topup() {
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let fund_out = vault_output(f0(), anchor_value(24_000_000))
  let member_out = vault_output(make_member(10, 3_000_000), member_ref_value())
  validate_deposit(
    policy(),
    f0(),
    a,
    1,
    0,
    1,
    2,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test deposit__rejects_units_above_band() {
  // band max is 100 — 101 units must fail
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let fund_out = vault_output(
    make_fund(0, 116, 116_000_000, 3_000_000, Active),
    anchor_value(123_000_000),
  )
  let member_out = vault_output(make_member(111, 3_000_000), member_ref_value())
  !validate_deposit(
    policy(),
    f0(),
    a,
    1,
    0,
    1,
    0,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test deposit__rejects_non_multiple_delta() {
  // 5.5 ADA is not a whole number of 1-ADA shares
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let fund_out = vault_output(
    make_fund(0, 20, 20_500_000, 3_000_000, Active),
    anchor_value(27_500_000),
  )
  let member_out = vault_output(make_member(15, 3_000_000), member_ref_value())
  !validate_deposit(
    policy(),
    f0(),
    a,
    1,
    0,
    1,
    0,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test deposit__rejects_missing_user_token() {
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let fund_out = vault_output(
    make_fund(0, 20, 20_000_000, 3_000_000, Active),
    anchor_value(27_000_000),
  )
  let member_out = vault_output(make_member(15, 3_000_000), member_ref_value())
  !validate_deposit(
    policy(),
    f0(),
    a,
    1,
    0,
    1,
    0,
    [a, m],
    [fund_out, member_out],
    no_mint(),
  )
}

test deposit__rejects_datum_drift() {
  // deposit that also tries to widen the purchase band
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let drifted = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 999,
    withdrawal_policy: 0,
    cycle_end: None,
    shares_total: 20,
    savings_total: 20_000_000,
    social_total: 3_000_000,
    status: Active,
  }
  let fund_out = vault_output(drifted, anchor_value(27_000_000))
  let member_out = vault_output(make_member(15, 3_000_000), member_ref_value())
  !validate_deposit(
    policy(),
    f0(),
    a,
    1,
    0,
    1,
    0,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test deposit__rejects_declared_shares_above_delta() {
  // datum claims +10 shares while only 5 ADA arrives
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let fund_out = vault_output(
    make_fund(0, 25, 25_000_000, 3_000_000, Active),
    anchor_value(27_000_000),
  )
  let member_out = vault_output(make_member(20, 3_000_000), member_ref_value())
  !validate_deposit(
    policy(),
    f0(),
    a,
    1,
    0,
    1,
    0,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test deposit__rejects_wrong_fund_member() fail {
  // the member account belongs to another fund — hard failure
  let a = anchor_in(f0(), 22_000_000)
  let foreign = vault_input(
    1,
    vault_output(
      MemberAccount {
        fund_id: #"beef",
        share_units: 10,
        social_paid: 0,
        consent: True,
        joined_at: 0,
      },
      member_ref_value(),
    ),
  )
  let fund_out = vault_output(
    make_fund(0, 20, 20_000_000, 3_000_000, Active),
    anchor_value(27_000_000),
  )
  let member_out = vault_output(make_member(15, 3_000_000), member_ref_value())
  expect
    validate_deposit(
      policy(),
      f0(),
      a,
      1,
      0,
      1,
      0,
      [a, foreign, user_token_input()],
      [fund_out, member_out],
      no_mint(),
    )
}

test deposit__rejects_while_sharing_out() fail {
  let sharing = make_fund(
    0,
    0,
    0,
    3_000_000,
    SharingOut { pot: 17_000_000, shares: 15, shares_remaining: 15 },
  )
  let a = anchor_in(sharing, 22_000_000)
  let m = member_in(10, 3_000_000)
  let fund_out = vault_output(sharing, anchor_value(27_000_000))
  let member_out = vault_output(make_member(15, 3_000_000), member_ref_value())
  expect
    validate_deposit(
      policy(),
      sharing,
      a,
      1,
      0,
      1,
      0,
      [a, m, user_token_input()],
      [fund_out, member_out],
      no_mint(),
    )
}

test deposit__rejects_own_policy_mint() {
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let fund_out = vault_output(
    make_fund(0, 20, 20_000_000, 3_000_000, Active),
    anchor_value(27_000_000),
  )
  let member_out = vault_output(make_member(15, 3_000_000), member_ref_value())
  !validate_deposit(
    policy(),
    f0(),
    a,
    1,
    0,
    1,
    0,
    [a, m, user_token_input()],
    [fund_out, member_out],
    assets.from_asset(policy(), #"beef", 1),
  )
}

// ── paired member-side branch ───────────────────────────────────────────────

test paired_member__accepts_when_fund_anchor_spent() {
  let a = anchor_in(f0(), 22_000_000)
  validate_paired_member(policy(), make_member(10, 0), 0, [a])
}

test paired_member__rejects_without_fund_anchor() fail {
  // index points at a wallet input — no fund NFT
  expect
    validate_paired_member(
      policy(),
      make_member(10, 0),
      0,
      [user_token_input()],
    )
}

// ── Withdraw ────────────────────────────────────────────────────────────────

fn f_flex() -> SavingsDatum {
  make_fund(1, 10, 10_000_000, 0, Active)
}

test withdraw__accepts_valid() {
  let a = anchor_in(f_flex(), 12_000_000)
  let m = member_in(10, 0)
  let fund_out = vault_output(
    make_fund(1, 6, 6_000_000, 0, Active),
    anchor_value(8_000_000),
  )
  let member_out = vault_output(make_member(6, 0), member_ref_value())
  validate_withdraw(
    policy(),
    f_flex(),
    a,
    1,
    0,
    1,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test withdraw__rejects_locked_policy() {
  // VSLA preset (withdrawal_policy 0) locks savings until share-out
  let locked = make_fund(0, 10, 10_000_000, 0, Active)
  let a = anchor_in(locked, 12_000_000)
  let m = member_in(10, 0)
  let fund_out = vault_output(
    make_fund(0, 6, 6_000_000, 0, Active),
    anchor_value(8_000_000),
  )
  let member_out = vault_output(make_member(6, 0), member_ref_value())
  !validate_withdraw(
    policy(),
    locked,
    a,
    1,
    0,
    1,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test withdraw__rejects_over_balance() {
  // member holds 10 of 15 total but tries to pull 12
  let f = make_fund(1, 15, 15_000_000, 0, Active)
  let a = anchor_in(f, 17_000_000)
  let m = member_in(10, 0)
  let fund_out = vault_output(
    make_fund(1, 3, 3_000_000, 0, Active),
    anchor_value(5_000_000),
  )
  let member_out = vault_output(make_member(-2, 0), member_ref_value())
  !validate_withdraw(
    policy(),
    f,
    a,
    1,
    0,
    1,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test withdraw__rejects_no_value_reduction() {
  // datum says 4 units left; the vault keeps all the money
  let a = anchor_in(f_flex(), 12_000_000)
  let m = member_in(10, 0)
  let fund_out = vault_output(
    make_fund(1, 6, 6_000_000, 0, Active),
    anchor_value(12_000_000),
  )
  let member_out = vault_output(make_member(6, 0), member_ref_value())
  !validate_withdraw(
    policy(),
    f_flex(),
    a,
    1,
    0,
    1,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test withdraw__rejects_missing_user_token() {
  let a = anchor_in(f_flex(), 12_000_000)
  let m = member_in(10, 0)
  let fund_out = vault_output(
    make_fund(1, 6, 6_000_000, 0, Active),
    anchor_value(8_000_000),
  )
  let member_out = vault_output(make_member(6, 0), member_ref_value())
  !validate_withdraw(
    policy(),
    f_flex(),
    a,
    1,
    0,
    1,
    [a, m],
    [fund_out, member_out],
    no_mint(),
  )
}

// ── SocialPayout ────────────────────────────────────────────────────────────

test social_payout__accepts_valid() {
  let a = anchor_in(f0(), 22_000_000)
  let fund_out = vault_output(
    make_fund(0, 15, 15_000_000, 1_000_000, Active),
    anchor_value(20_000_000),
  )
  validate_social_payout(
    policy(),
    f0(),
    a,
    0,
    [fund_out],
    no_mint(),
    quorum_tx(),
  )
}

test social_payout__accepts_during_sharing_out() {
  let sharing = make_fund(
    0,
    0,
    0,
    3_000_000,
    SharingOut { pot: 17_000_000, shares: 15, shares_remaining: 15 },
  )
  let a = anchor_in(sharing, 22_000_000)
  let fund_out = vault_output(
    make_fund(
      0,
      0,
      0,
      1_000_000,
      SharingOut { pot: 17_000_000, shares: 15, shares_remaining: 15 },
    ),
    anchor_value(20_000_000),
  )
  validate_social_payout(
    policy(),
    sharing,
    a,
    0,
    [fund_out],
    no_mint(),
    quorum_tx(),
  )
}

test social_payout__rejects_unsigned() {
  let a = anchor_in(f0(), 22_000_000)
  let fund_out = vault_output(
    make_fund(0, 15, 15_000_000, 1_000_000, Active),
    anchor_value(20_000_000),
  )
  !validate_social_payout(
    policy(),
    f0(),
    a,
    0,
    [fund_out],
    no_mint(),
    unsigned_tx(),
  )
}

test social_payout__rejects_over_social_fund() {
  // 5 ADA out of a 3 ADA social fund — member savings are out of reach
  let a = anchor_in(f0(), 22_000_000)
  let fund_out = vault_output(
    make_fund(0, 15, 15_000_000, -2_000_000, Active),
    anchor_value(17_000_000),
  )
  !validate_social_payout(
    policy(),
    f0(),
    a,
    0,
    [fund_out],
    no_mint(),
    quorum_tx(),
  )
}

test social_payout__rejects_no_value_reduction() {
  let a = anchor_in(f0(), 22_000_000)
  let fund_out = vault_output(
    make_fund(0, 15, 15_000_000, 1_000_000, Active),
    anchor_value(22_000_000),
  )
  !validate_social_payout(
    policy(),
    f0(),
    a,
    0,
    [fund_out],
    no_mint(),
    quorum_tx(),
  )
}

// ── UpdateFund ──────────────────────────────────────────────────────────────

test update_fund__accepts_band_widen_and_rotation() {
  let a = anchor_in(f0(), 22_000_000)
  let updated = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.key_credential(
      #"deaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
    ),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 200,
    withdrawal_policy: 1,
    cycle_end: Some(1_800_000_000_000),
    shares_total: 15,
    savings_total: 15_000_000,
    social_total: 3_000_000,
    status: Active,
  }
  let fund_out = vault_output(updated, anchor_value(22_000_000))
  validate_update_fund(policy(), f0(), a, 0, [fund_out], no_mint(), quorum_tx())
}

test update_fund__rejects_share_value_change() {
  let a = anchor_in(f0(), 22_000_000)
  let bad = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 2_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    cycle_end: None,
    shares_total: 15,
    savings_total: 15_000_000,
    social_total: 3_000_000,
    status: Active,
  }
  let fund_out = vault_output(bad, anchor_value(22_000_000))
  !validate_update_fund(
    policy(),
    f0(),
    a,
    0,
    [fund_out],
    no_mint(),
    quorum_tx(),
  )
}

test update_fund__rejects_totals_change() {
  let a = anchor_in(f0(), 22_000_000)
  let bad = make_fund(0, 15, 15_000_000, 0, Active)
  let fund_out = vault_output(bad, anchor_value(22_000_000))
  !validate_update_fund(
    policy(),
    f0(),
    a,
    0,
    [fund_out],
    no_mint(),
    quorum_tx(),
  )
}

test update_fund__rejects_value_change() {
  let a = anchor_in(f0(), 22_000_000)
  let fund_out = vault_output(f0(), anchor_value(21_000_000))
  !validate_update_fund(
    policy(),
    f0(),
    a,
    0,
    [fund_out],
    no_mint(),
    quorum_tx(),
  )
}

test update_fund__rejects_unsigned() {
  let a = anchor_in(f0(), 22_000_000)
  let fund_out = vault_output(f0(), anchor_value(22_000_000))
  !validate_update_fund(
    policy(),
    f0(),
    a,
    0,
    [fund_out],
    no_mint(),
    unsigned_tx(),
  )
}

// ── CloseCycle ──────────────────────────────────────────────────────────────

fn sharing_datum() -> SavingsDatum {
  make_fund(
    0,
    0,
    0,
    3_000_000,
    SharingOut { pot: 17_000_000, shares: 15, shares_remaining: 15 },
  )
}

test close_cycle__accepts_exact_pot() {
  // vault 22 - social 3 - ADA buffer 2 = pot 17
  let a = anchor_in(f0(), 22_000_000)
  let fund_out = vault_output(sharing_datum(), anchor_value(22_000_000))
  validate_close_cycle(policy(), f0(), a, 0, [fund_out], no_mint(), quorum_tx())
}

test close_cycle__rejects_understated_pot() {
  // quorum tries to shrink the pot (enlarging the closure residual)
  let a = anchor_in(f0(), 22_000_000)
  let smaller = make_fund(
    0,
    0,
    0,
    3_000_000,
    SharingOut { pot: 10_000_000, shares: 15, shares_remaining: 15 },
  )
  let fund_out = vault_output(smaller, anchor_value(22_000_000))
  !validate_close_cycle(
    policy(),
    f0(),
    a,
    0,
    [fund_out],
    no_mint(),
    quorum_tx(),
  )
}

test close_cycle__rejects_value_moved() {
  let a = anchor_in(f0(), 22_000_000)
  let fund_out = vault_output(sharing_datum(), anchor_value(20_000_000))
  !validate_close_cycle(
    policy(),
    f0(),
    a,
    0,
    [fund_out],
    no_mint(),
    quorum_tx(),
  )
}

test close_cycle__rejects_unsigned() {
  let a = anchor_in(f0(), 22_000_000)
  let fund_out = vault_output(sharing_datum(), anchor_value(22_000_000))
  !validate_close_cycle(
    policy(),
    f0(),
    a,
    0,
    [fund_out],
    no_mint(),
    unsigned_tx(),
  )
}

test close_cycle__rejects_before_cycle_end() {
  let bounded = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    cycle_end: Some(1_900_000_000_000),
    shares_total: 15,
    savings_total: 15_000_000,
    social_total: 3_000_000,
    status: Active,
  }
  let a = anchor_in(bounded, 22_000_000)
  let out_datum = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    cycle_end: Some(1_900_000_000_000),
    shares_total: 0,
    savings_total: 0,
    social_total: 3_000_000,
    status: SharingOut { pot: 17_000_000, shares: 15, shares_remaining: 15 },
  }
  let fund_out = vault_output(out_datum, anchor_value(22_000_000))
  // quorum_tx validity starts at 1_700_… — before the 1_900_… cycle end
  !validate_close_cycle(
    policy(),
    bounded,
    a,
    0,
    [fund_out],
    no_mint(),
    quorum_tx(),
  )
}

test close_cycle__rejects_zero_shares() {
  let empty = make_fund(0, 0, 0, 0, Active)
  let a = anchor_in(empty, 22_000_000)
  let fund_out = vault_output(
    make_fund(
      0,
      0,
      0,
      0,
      SharingOut { pot: 20_000_000, shares: 0, shares_remaining: 0 },
    ),
    anchor_value(22_000_000),
  )
  !validate_close_cycle(
    policy(),
    empty,
    a,
    0,
    [fund_out],
    no_mint(),
    quorum_tx(),
  )
}

// ── ClaimShareOut ───────────────────────────────────────────────────────────

test claim__accepts_floor_payout() {
  // paid = 17_000_000 * 10 / 15 = 11_333_333 (floor)
  let a = anchor_in(sharing_datum(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let after_claim = make_fund(
    0,
    0,
    0,
    3_000_000,
    SharingOut { pot: 17_000_000, shares: 15, shares_remaining: 5 },
  )
  let fund_out = vault_output(after_claim, anchor_value(10_666_667))
  let member_out = vault_output(make_member(0, 3_000_000), member_ref_value())
  validate_claim_share_out(
    policy(),
    sharing_datum(),
    a,
    1,
    0,
    1,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test claim__rejects_overpayment() {
  // one lovelace above the floor payout
  let a = anchor_in(sharing_datum(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let after_claim = make_fund(
    0,
    0,
    0,
    3_000_000,
    SharingOut { pot: 17_000_000, shares: 15, shares_remaining: 5 },
  )
  let fund_out = vault_output(after_claim, anchor_value(10_666_666))
  let member_out = vault_output(make_member(0, 3_000_000), member_ref_value())
  !validate_claim_share_out(
    policy(),
    sharing_datum(),
    a,
    1,
    0,
    1,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test claim__rejects_pot_mutation() {
  // the claimer tries to bump the pot for later claims
  let a = anchor_in(sharing_datum(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let mutated = make_fund(
    0,
    0,
    0,
    3_000_000,
    SharingOut { pot: 20_000_000, shares: 15, shares_remaining: 5 },
  )
  let fund_out = vault_output(mutated, anchor_value(10_666_667))
  let member_out = vault_output(make_member(0, 3_000_000), member_ref_value())
  !validate_claim_share_out(
    policy(),
    sharing_datum(),
    a,
    1,
    0,
    1,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test claim__rejects_zero_unit_account() {
  let a = anchor_in(sharing_datum(), 22_000_000)
  let m = member_in(0, 3_000_000)
  let fund_out = vault_output(sharing_datum(), anchor_value(22_000_000))
  let member_out = vault_output(make_member(0, 3_000_000), member_ref_value())
  !validate_claim_share_out(
    policy(),
    sharing_datum(),
    a,
    1,
    0,
    1,
    [a, m, user_token_input()],
    [fund_out, member_out],
    no_mint(),
  )
}

test claim__rejects_missing_user_token() {
  let a = anchor_in(sharing_datum(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let after_claim = make_fund(
    0,
    0,
    0,
    3_000_000,
    SharingOut { pot: 17_000_000, shares: 15, shares_remaining: 5 },
  )
  let fund_out = vault_output(after_claim, anchor_value(10_666_667))
  let member_out = vault_output(make_member(0, 3_000_000), member_ref_value())
  !validate_claim_share_out(
    policy(),
    sharing_datum(),
    a,
    1,
    0,
    1,
    [a, m],
    [fund_out, member_out],
    no_mint(),
  )
}

test claim__rejects_while_active() fail {
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(10, 3_000_000)
  let fund_out = vault_output(f0(), anchor_value(22_000_000))
  let member_out = vault_output(make_member(0, 3_000_000), member_ref_value())
  expect
    validate_claim_share_out(
      policy(),
      f0(),
      a,
      1,
      0,
      1,
      [a, m, user_token_input()],
      [fund_out, member_out],
      no_mint(),
    )
}

// ── RemoveAccount ───────────────────────────────────────────────────────────

fn burn_pair() {
  assets.from_asset(policy(), ref_name(), -1)
    |> assets.add(policy(), user_name(), -1)
}

test remove_account__accepts_zeroed_exit() {
  let m = member_in(0, 3_000_000)
  validate_remove_account(
    policy(),
    make_member(0, 3_000_000),
    m,
    [m, user_token_input()],
    burn_pair(),
  )
}

test remove_account__rejects_nonzero_balance() {
  let m = member_in(4, 0)
  !validate_remove_account(
    policy(),
    make_member(4, 0),
    m,
    [m, user_token_input()],
    burn_pair(),
  )
}

test remove_account__rejects_missing_user_token() {
  let m = member_in(0, 0)
  !validate_remove_account(policy(), make_member(0, 0), m, [m], burn_pair())
}

test remove_account__rejects_ref_only_burn() {
  let m = member_in(0, 0)
  let half = assets.from_asset(policy(), ref_name(), -1)
  !validate_remove_account(
    policy(),
    make_member(0, 0),
    m,
    [m, user_token_input()],
    half,
  )
}

// ── CloseFund ───────────────────────────────────────────────────────────────

fn done_datum() -> SavingsDatum {
  make_fund(
    0,
    0,
    0,
    0,
    SharingOut { pot: 17_000_000, shares: 15, shares_remaining: 0 },
  )
}

test close_fund__accepts_completed_shareout() {
  let a = anchor_in(done_datum(), 2_000_045)
  validate_close_fund(
    policy(),
    done_datum(),
    a,
    assets.from_asset(policy(), fund_name(), -1),
    quorum_tx(),
  )
}

test close_fund__rejects_unclaimed_shares() {
  let a = anchor_in(sharing_datum(), 22_000_000)
  !validate_close_fund(
    policy(),
    sharing_datum(),
    a,
    assets.from_asset(policy(), fund_name(), -1),
    quorum_tx(),
  )
}

test close_fund__rejects_unsigned() {
  let a = anchor_in(done_datum(), 2_000_045)
  !validate_close_fund(
    policy(),
    done_datum(),
    a,
    assets.from_asset(policy(), fund_name(), -1),
    unsigned_tx(),
  )
}

test close_fund__rejects_missing_burn() {
  let a = anchor_in(done_datum(), 2_000_045)
  !validate_close_fund(policy(), done_datum(), a, assets.zero, quorum_tx())
}

test close_fund__rejects_while_active() fail {
  let a = anchor_in(f0(), 22_000_000)
  expect
    validate_close_fund(
      policy(),
      f0(),
      a,
      assets.from_asset(policy(), fund_name(), -1),
      quorum_tx(),
    )
}
