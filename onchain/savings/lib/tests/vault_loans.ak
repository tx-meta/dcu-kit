use aiken/fuzz
use cardano/assets
use cardano/transaction.{Input}
use savings/types.{
  Active, Current, Defaulted, Late, LoanAccount, SavingsDatum, SavingsFund,
}
use savings/validation.{
  validate_burn_loan, validate_disburse_loan, validate_mark_arrears,
  validate_mint_loan, validate_repay_loan, validate_write_off_loan,
}
use tests/common.{
  anchor_value, fund_name, loan_name, loan_seed_ref, loan_value, make_fund,
  make_loan, make_member, make_member_borrowed, member_ref_value, policy,
  quorum_tx, quorum_tx_bounded, ref_name, seed_input, tx_after, unsigned_tx,
  user_token_input, vault_input, vault_output,
}

// Standing fixture: ADA fund, 15 shares (this member 10), social 3, vault 22.
fn f0() -> SavingsDatum {
  make_fund(0, 15, 15_000_000, 3_000_000, Active)
}

fn anchor_in(datum: SavingsDatum, lovelace: Int) -> Input {
  vault_input(0, vault_output(datum, anchor_value(lovelace)))
}

fn member_in(datum: SavingsDatum) -> Input {
  vault_input(1, vault_output(datum, member_ref_value()))
}

fn loan_in(datum: SavingsDatum) -> Input {
  vault_input(2, vault_output(datum, loan_value()))
}

// A fund with the loan book carrying one 8 ADA loan (post-disbursement).
fn f_loaned() -> SavingsDatum {
  SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 1,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 15,
    savings_total: 15_000_000,
    social_total: 3_000_000,
    loans_outstanding: 8_000_000,
    status: Active,
  }
}

fn mint_loan_nft() {
  assets.from_asset(policy(), loan_name(), 1)
}

fn burn_loan_nft() {
  assets.from_asset(policy(), loan_name(), -1)
}

// ── DisburseLoan ────────────────────────────────────────────────────────────

fn disburse_outputs(fund_after: SavingsDatum, vault_after: Int) {
  [
    vault_output(fund_after, anchor_value(vault_after)),
    vault_output(
      make_member_borrowed(10, 3_000_000, 8_000_000),
      member_ref_value(),
    ),
    vault_output(make_loan(8_000_000, 0, Current), loan_value()),
  ]
}

test disburse__accepts_valid() {
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(make_member(10, 3_000_000))
  validate_disburse_loan(
    policy(),
    f0(),
    a,
    1,
    3,
    0,
    1,
    2,
    [a, m, user_token_input(), seed_input(loan_seed_ref())],
    disburse_outputs(f_loaned(), 14_000_000),
    mint_loan_nft(),
    quorum_tx_bounded(),
  )
}

test disburse__rejects_unsigned_quorum() {
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(make_member(10, 3_000_000))
  let tx = common.tx_bounded_unsigned()
  !validate_disburse_loan(
    policy(),
    f0(),
    a,
    1,
    3,
    0,
    1,
    2,
    [a, m, user_token_input(), seed_input(loan_seed_ref())],
    disburse_outputs(f_loaned(), 14_000_000),
    mint_loan_nft(),
    tx,
  )
}

test disburse__rejects_missing_borrower_consent() {
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(make_member(10, 3_000_000))
  !validate_disburse_loan(
    policy(),
    f0(),
    a,
    1,
    2,
    0,
    1,
    2,
    [a, m, seed_input(loan_seed_ref())],
    disburse_outputs(f_loaned(), 14_000_000),
    mint_loan_nft(),
    quorum_tx_bounded(),
  )
}

test disburse__rejects_over_eligibility() {
  // 11 ADA loan against 10 ADA of shares at multiple 1
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(make_member(10, 3_000_000))
  let big_loan = LoanAccount {
    fund_id: fund_name(),
    borrower_ref: ref_name(),
    principal: 11_000_000,
    outstanding: 11_000_000,
    service_charge: 400_000,
    charge_paid: 0,
    due: 1_750_000_000_000,
    grace: 604_800_000,
    status: Current,
  }
  let fund_after = make_fund(0, 15, 15_000_000, 3_000_000, Active)
  // (datum equality would also fail; eligibility is checked regardless)
  let outputs = [
    vault_output(fund_after, anchor_value(11_000_000)),
    vault_output(
      make_member_borrowed(10, 3_000_000, 11_000_000),
      member_ref_value(),
    ),
    vault_output(big_loan, loan_value()),
  ]
  !validate_disburse_loan(
    policy(),
    f0(),
    a,
    1,
    3,
    0,
    1,
    2,
    [a, m, user_token_input(), seed_input(loan_seed_ref())],
    outputs,
    mint_loan_nft(),
    quorum_tx_bounded(),
  )
}

test disburse__rejects_second_loan() {
  let a = anchor_in(f_loaned(), 14_000_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 8_000_000))
  !validate_disburse_loan(
    policy(),
    f_loaned(),
    a,
    1,
    3,
    0,
    1,
    2,
    [a, m, user_token_input(), seed_input(loan_seed_ref())],
    disburse_outputs(f_loaned(), 6_000_000),
    mint_loan_nft(),
    quorum_tx_bounded(),
  )
}

test disburse__rejects_liquidity_breach() {
  // multiple 2: member 10 shares may borrow 14, but vault 15 - 14 = 1 would
  // dip below social 3 + buffer 2
  let charter = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 2,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 10,
    savings_total: 10_000_000,
    social_total: 3_000_000,
    loans_outstanding: 0,
    status: Active,
  }
  let after = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 2,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 10,
    savings_total: 10_000_000,
    social_total: 3_000_000,
    loans_outstanding: 14_000_000,
    status: Active,
  }
  let big_loan = LoanAccount {
    fund_id: fund_name(),
    borrower_ref: ref_name(),
    principal: 14_000_000,
    outstanding: 14_000_000,
    service_charge: 400_000,
    charge_paid: 0,
    due: 1_750_000_000_000,
    grace: 604_800_000,
    status: Current,
  }
  let a = anchor_in(charter, 15_000_000)
  let m = member_in(make_member(10, 3_000_000))
  let outputs = [
    vault_output(after, anchor_value(1_000_000)),
    vault_output(
      make_member_borrowed(10, 3_000_000, 14_000_000),
      member_ref_value(),
    ),
    vault_output(big_loan, loan_value()),
  ]
  !validate_disburse_loan(
    policy(),
    charter,
    a,
    1,
    3,
    0,
    1,
    2,
    [a, m, user_token_input(), seed_input(loan_seed_ref())],
    outputs,
    mint_loan_nft(),
    quorum_tx_bounded(),
  )
}

test disburse__rejects_wrong_grace() {
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(make_member(10, 3_000_000))
  let short_grace = LoanAccount {
    fund_id: fund_name(),
    borrower_ref: ref_name(),
    principal: 8_000_000,
    outstanding: 8_000_000,
    service_charge: 400_000,
    charge_paid: 0,
    due: 1_750_000_000_000,
    grace: 1,
    status: Current,
  }
  let outputs = [
    vault_output(f_loaned(), anchor_value(14_000_000)),
    vault_output(
      make_member_borrowed(10, 3_000_000, 8_000_000),
      member_ref_value(),
    ),
    vault_output(short_grace, loan_value()),
  ]
  !validate_disburse_loan(
    policy(),
    f0(),
    a,
    1,
    3,
    0,
    1,
    2,
    [a, m, user_token_input(), seed_input(loan_seed_ref())],
    outputs,
    mint_loan_nft(),
    quorum_tx_bounded(),
  )
}

test disburse__rejects_book_understated() {
  // vault pays out 8 but the book only records 5
  let a = anchor_in(f0(), 22_000_000)
  let m = member_in(make_member(10, 3_000_000))
  let understated = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 1,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 15,
    savings_total: 15_000_000,
    social_total: 3_000_000,
    loans_outstanding: 5_000_000,
    status: Active,
  }
  !validate_disburse_loan(
    policy(),
    f0(),
    a,
    1,
    3,
    0,
    1,
    2,
    [a, m, user_token_input(), seed_input(loan_seed_ref())],
    disburse_outputs(understated, 14_000_000),
    mint_loan_nft(),
    quorum_tx_bounded(),
  )
}

// ── RepayLoan ───────────────────────────────────────────────────────────────

test repay__accepts_partial() {
  // 5 ADA principal + full 0.4 ADA charge
  let a = anchor_in(f_loaned(), 14_000_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 8_000_000))
  let l = loan_in(make_loan(8_000_000, 0, Current))
  let outputs = [
    vault_output(repay_fund_after(3_000_000), anchor_value(19_400_000)),
    vault_output(
      make_member_borrowed(10, 3_000_000, 3_000_000),
      member_ref_value(),
    ),
    vault_output(make_loan(3_000_000, 400_000, Current), loan_value()),
  ]
  validate_repay_loan(
    policy(),
    f_loaned(),
    a,
    1,
    2,
    0,
    1,
    2,
    [a, m, l, user_token_input()],
    outputs,
    assets.zero,
  )
}

fn repay_fund_after(loans_outstanding: Int) -> SavingsDatum {
  SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 1,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 15,
    savings_total: 15_000_000,
    social_total: 3_000_000,
    loans_outstanding,
    status: Active,
  }
}

test repay__accepts_closing() {
  // remaining 3 ADA principal, charge already fully paid — burns the NFT
  let a = anchor_in(repay_fund_after(3_000_000), 19_400_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 3_000_000))
  let l = loan_in(make_loan(3_000_000, 400_000, Current))
  let outputs = [
    vault_output(repay_fund_after(0), anchor_value(22_400_000)),
    vault_output(make_member_borrowed(10, 3_000_000, 0), member_ref_value()),
  ]
  validate_repay_loan(
    policy(),
    repay_fund_after(3_000_000),
    a,
    1,
    2,
    0,
    1,
    99,
    [a, m, l, user_token_input()],
    outputs,
    burn_loan_nft(),
  )
}

test repay__rejects_no_vault_gain() {
  // datum says repaid; the vault kept its old balance
  let a = anchor_in(f_loaned(), 14_000_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 8_000_000))
  let l = loan_in(make_loan(8_000_000, 0, Current))
  let outputs = [
    vault_output(repay_fund_after(3_000_000), anchor_value(14_000_000)),
    vault_output(
      make_member_borrowed(10, 3_000_000, 3_000_000),
      member_ref_value(),
    ),
    vault_output(make_loan(3_000_000, 400_000, Current), loan_value()),
  ]
  !validate_repay_loan(
    policy(),
    f_loaned(),
    a,
    1,
    2,
    0,
    1,
    2,
    [a, m, l, user_token_input()],
    outputs,
    assets.zero,
  )
}

test repay__rejects_term_mutation() {
  // repayment that also pushes the due date out
  let a = anchor_in(f_loaned(), 14_000_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 8_000_000))
  let l = loan_in(make_loan(8_000_000, 0, Current))
  let mutated = LoanAccount {
    fund_id: fund_name(),
    borrower_ref: ref_name(),
    principal: 8_000_000,
    outstanding: 3_000_000,
    service_charge: 400_000,
    charge_paid: 400_000,
    due: 1_999_000_000_000,
    grace: 604_800_000,
    status: Current,
  }
  let outputs = [
    vault_output(repay_fund_after(3_000_000), anchor_value(19_400_000)),
    vault_output(
      make_member_borrowed(10, 3_000_000, 3_000_000),
      member_ref_value(),
    ),
    vault_output(mutated, loan_value()),
  ]
  !validate_repay_loan(
    policy(),
    f_loaned(),
    a,
    1,
    2,
    0,
    1,
    2,
    [a, m, l, user_token_input()],
    outputs,
    assets.zero,
  )
}

test repay__rejects_missing_user_token() {
  let a = anchor_in(f_loaned(), 14_000_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 8_000_000))
  let l = loan_in(make_loan(8_000_000, 0, Current))
  let outputs = [
    vault_output(repay_fund_after(3_000_000), anchor_value(19_400_000)),
    vault_output(
      make_member_borrowed(10, 3_000_000, 3_000_000),
      member_ref_value(),
    ),
    vault_output(make_loan(3_000_000, 400_000, Current), loan_value()),
  ]
  !validate_repay_loan(
    policy(),
    f_loaned(),
    a,
    1,
    2,
    0,
    1,
    2,
    [a, m, l],
    outputs,
    assets.zero,
  )
}

test repay__closing_rejects_missing_burn() {
  let a = anchor_in(repay_fund_after(3_000_000), 19_400_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 3_000_000))
  let l = loan_in(make_loan(3_000_000, 400_000, Current))
  let outputs = [
    vault_output(repay_fund_after(0), anchor_value(22_400_000)),
    vault_output(make_member_borrowed(10, 3_000_000, 0), member_ref_value()),
  ]
  !validate_repay_loan(
    policy(),
    repay_fund_after(3_000_000),
    a,
    1,
    2,
    0,
    1,
    99,
    [a, m, l, user_token_input()],
    outputs,
    assets.zero,
  )
}

// A Defaulted borrower can always still repay.
test repay__accepts_from_defaulted() {
  let a = anchor_in(f_loaned(), 14_000_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 8_000_000))
  let l = loan_in(make_loan(8_000_000, 0, Defaulted))
  let outputs = [
    vault_output(repay_fund_after(0), anchor_value(22_400_000)),
    vault_output(make_member_borrowed(10, 3_000_000, 0), member_ref_value()),
  ]
  validate_repay_loan(
    policy(),
    f_loaned(),
    a,
    1,
    2,
    0,
    1,
    99,
    [a, m, l, user_token_input()],
    outputs,
    burn_loan_nft(),
  )
}

// ── MarkArrears ─────────────────────────────────────────────────────────────

fn arrears_loan_in(status) -> Input {
  vault_input(0, vault_output(make_loan(8_000_000, 0, status), loan_value()))
}

test arrears__accepts_current_to_late() {
  let l = arrears_loan_in(Current)
  validate_mark_arrears(
    policy(),
    make_loan(8_000_000, 0, Current),
    l,
    0,
    [vault_output(make_loan(8_000_000, 0, Late), loan_value())],
    assets.zero,
    tx_after(1_750_000_000_001),
  )
}

test arrears__accepts_late_to_defaulted() {
  let l = arrears_loan_in(Late)
  validate_mark_arrears(
    policy(),
    make_loan(8_000_000, 0, Late),
    l,
    0,
    [vault_output(make_loan(8_000_000, 0, Defaulted), loan_value())],
    assets.zero,
    tx_after(1_750_604_800_001),
  )
}

test arrears__rejects_before_due() {
  let l = arrears_loan_in(Current)
  !validate_mark_arrears(
    policy(),
    make_loan(8_000_000, 0, Current),
    l,
    0,
    [vault_output(make_loan(8_000_000, 0, Late), loan_value())],
    assets.zero,
    tx_after(1_700_000_000_000),
  )
}

test arrears__rejects_double_step() {
  // long past due + grace, but Current may only advance ONE step
  let l = arrears_loan_in(Current)
  !validate_mark_arrears(
    policy(),
    make_loan(8_000_000, 0, Current),
    l,
    0,
    [vault_output(make_loan(8_000_000, 0, Defaulted), loan_value())],
    assets.zero,
    tx_after(1_999_000_000_000),
  )
}

test arrears__rejects_defaulted_advance() {
  let l = arrears_loan_in(Defaulted)
  !validate_mark_arrears(
    policy(),
    make_loan(8_000_000, 0, Defaulted),
    l,
    0,
    [vault_output(make_loan(8_000_000, 0, Defaulted), loan_value())],
    assets.zero,
    tx_after(1_999_000_000_000),
  )
}

test arrears__rejects_value_change() {
  let l = arrears_loan_in(Current)
  !validate_mark_arrears(
    policy(),
    make_loan(8_000_000, 0, Current),
    l,
    0,
    [
      vault_output(
        make_loan(8_000_000, 0, Late),
        assets.from_lovelace(1_000_000)
          |> assets.add(policy(), loan_name(), 1),
      ),
    ],
    assets.zero,
    tx_after(1_750_000_000_001),
  )
}

// ── WriteOffLoan ────────────────────────────────────────────────────────────

test write_off__accepts_full_seizure() {
  // outstanding 3 ADA, member holds 10 shares -> seize exactly 3
  let f = repay_fund_after(3_000_000)
  let a = anchor_in(f, 19_400_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 3_000_000))
  let l = loan_in(make_loan(3_000_000, 400_000, Defaulted))
  let fund_after = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 1,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 12,
    savings_total: 12_000_000,
    social_total: 3_000_000,
    loans_outstanding: 0,
    status: Active,
  }
  let outputs = [
    vault_output(fund_after, anchor_value(19_400_000)),
    vault_output(make_member_borrowed(7, 3_000_000, 0), member_ref_value()),
  ]
  validate_write_off_loan(
    policy(),
    f,
    a,
    1,
    2,
    0,
    1,
    [a, m, l],
    outputs,
    burn_loan_nft(),
    quorum_tx(),
  )
}

test write_off__accepts_partial_seizure_socialized() {
  // outstanding 8 ADA, member holds only 5 shares -> seize 5, socialize 3
  let f = f_loaned()
  let a = anchor_in(f, 14_000_000)
  let m = member_in(make_member_borrowed(5, 0, 8_000_000))
  let l = loan_in(make_loan(8_000_000, 0, Defaulted))
  let fund_after = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 1,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 10,
    savings_total: 10_000_000,
    social_total: 3_000_000,
    loans_outstanding: 0,
    status: Active,
  }
  let outputs = [
    vault_output(fund_after, anchor_value(14_000_000)),
    vault_output(make_member_borrowed(0, 0, 0), member_ref_value()),
  ]
  validate_write_off_loan(
    policy(),
    f,
    a,
    1,
    2,
    0,
    1,
    [a, m, l],
    outputs,
    burn_loan_nft(),
    quorum_tx(),
  )
}

test write_off__rejects_not_defaulted() {
  let f = f_loaned()
  let a = anchor_in(f, 14_000_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 8_000_000))
  let l = loan_in(make_loan(8_000_000, 0, Late))
  let outputs = [
    vault_output(repay_fund_after(0), anchor_value(14_000_000)),
    vault_output(make_member_borrowed(2, 3_000_000, 0), member_ref_value()),
  ]
  !validate_write_off_loan(
    policy(),
    f,
    a,
    1,
    2,
    0,
    1,
    [a, m, l],
    outputs,
    burn_loan_nft(),
    quorum_tx(),
  )
}

test write_off__rejects_unsigned() {
  let f = repay_fund_after(3_000_000)
  let a = anchor_in(f, 19_400_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 3_000_000))
  let l = loan_in(make_loan(3_000_000, 400_000, Defaulted))
  let outputs = [
    vault_output(repay_fund_after(0), anchor_value(19_400_000)),
    vault_output(make_member_borrowed(7, 3_000_000, 0), member_ref_value()),
  ]
  !validate_write_off_loan(
    policy(),
    f,
    a,
    1,
    2,
    0,
    1,
    [a, m, l],
    outputs,
    burn_loan_nft(),
    unsigned_tx(),
  )
}

test write_off__rejects_value_taken() {
  // a write-off must move no money out of the vault
  let f = repay_fund_after(3_000_000)
  let a = anchor_in(f, 19_400_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 3_000_000))
  let l = loan_in(make_loan(3_000_000, 400_000, Defaulted))
  let fund_after = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 1,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 12,
    savings_total: 12_000_000,
    social_total: 3_000_000,
    loans_outstanding: 0,
    status: Active,
  }
  let outputs = [
    vault_output(fund_after, anchor_value(16_400_000)),
    vault_output(make_member_borrowed(7, 3_000_000, 0), member_ref_value()),
  ]
  !validate_write_off_loan(
    policy(),
    f,
    a,
    1,
    2,
    0,
    1,
    [a, m, l],
    outputs,
    burn_loan_nft(),
    quorum_tx(),
  )
}

// ── mint side ───────────────────────────────────────────────────────────────

test mint_loan__accepts_valid() {
  let a = anchor_in(f0(), 22_000_000)
  validate_mint_loan(
    policy(),
    1,
    [a, seed_input(loan_seed_ref())],
    mint_loan_nft(),
  )
}

test mint_loan__rejects_wrong_name() {
  let a = anchor_in(f0(), 22_000_000)
  !validate_mint_loan(
    policy(),
    1,
    [a, seed_input(loan_seed_ref())],
    assets.from_asset(policy(), fund_name(), 1),
  )
}

test mint_loan__rejects_no_vault_spend() {
  !validate_mint_loan(
    policy(),
    0,
    [seed_input(loan_seed_ref())],
    mint_loan_nft(),
  )
}

test burn_loan__accepts_state_token() {
  validate_burn_loan(policy(), burn_loan_nft())
}

test burn_loan__rejects_cip68_name() {
  !validate_burn_loan(policy(), assets.from_asset(policy(), ref_name(), -1))
}

// ── properties ──────────────────────────────────────────────────────────────

// Any partial principal repayment (1..outstanding lovelace) settles exactly.
test prop_repay_partial_any_amount(p via fuzz.int_between(1, 8)) {
  let paid = p * 1_000_000
  let a = anchor_in(f_loaned(), 14_000_000)
  let m = member_in(make_member_borrowed(10, 3_000_000, 8_000_000))
  let l = loan_in(make_loan(8_000_000, 0, Current))
  let closing = paid == 8_000_000
  if closing {
    // full principal + full charge closes
    let outputs = [
      vault_output(
        repay_fund_after(0),
        anchor_value(14_000_000 + paid + 400_000),
      ),
      vault_output(make_member_borrowed(10, 3_000_000, 0), member_ref_value()),
    ]
    validate_repay_loan(
      policy(),
      f_loaned(),
      a,
      1,
      2,
      0,
      1,
      99,
      [a, m, l, user_token_input()],
      outputs,
      burn_loan_nft(),
    )
  } else {
    let outputs = [
      vault_output(
        repay_fund_after(8_000_000 - paid),
        anchor_value(14_000_000 + paid),
      ),
      vault_output(
        make_member_borrowed(10, 3_000_000, 8_000_000 - paid),
        member_ref_value(),
      ),
      vault_output(make_loan(8_000_000 - paid, 0, Current), loan_value()),
    ]
    validate_repay_loan(
      policy(),
      f_loaned(),
      a,
      1,
      2,
      0,
      1,
      2,
      [a, m, l, user_token_input()],
      outputs,
      assets.zero,
    )
  }
}

// Seizure never exceeds the member's shares, and clears the book regardless.
test prop_write_off_seizure_bounded(units via fuzz.int_between(1, 12)) {
  let f = f_loaned()
  let a = anchor_in(f, 14_000_000)
  let m = member_in(make_member_borrowed(units, 0, 8_000_000))
  let l = loan_in(make_loan(8_000_000, 0, Defaulted))
  let seized = if units < 8 {
    units
  } else {
    8
  }
  let fund_after = SavingsFund {
    title: #"546573742046756e64",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 1,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 15 - seized,
    savings_total: ( 15 - seized ) * 1_000_000,
    social_total: 3_000_000,
    loans_outstanding: 0,
    status: Active,
  }
  let outputs = [
    vault_output(fund_after, anchor_value(14_000_000)),
    vault_output(make_member_borrowed(units - seized, 0, 0), member_ref_value()),
  ]
  validate_write_off_loan(
    policy(),
    f,
    a,
    1,
    2,
    0,
    1,
    [a, m, l],
    outputs,
    burn_loan_nft(),
    quorum_tx(),
  )
}

// The satellite branch accepts loan records too (not only member accounts).
test paired_satellite__accepts_loan_record() {
  let a = anchor_in(f_loaned(), 14_000_000)
  savings_validation_paired(a)
}

fn savings_validation_paired(a: Input) {
  validation.validate_paired_member(
    policy(),
    make_loan(8_000_000, 0, Current),
    0,
    [a],
  )
}
