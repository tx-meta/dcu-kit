use cardano/assets
use cardano/transaction.{Input, Output}
use savings/types.{Active, MemberAccount, SavingsFund, SharingOut}
use savings/validation.{
  validate_burn_account, validate_burn_fund, validate_create_fund,
  validate_mint_account,
}
use tests/common.{
  active_fund, anchor_value, fund_name, fund_seed_ref, make_fund,
  member_ref_value, member_seed_ref, policy, range_between, ref_name, seed_input,
  user_name, vault_input, vault_output, wallet_output,
}

// ── CreateFund ──────────────────────────────────────────────────────────────

fn create_mint() {
  assets.from_asset(policy(), fund_name(), 1)
}

test create_fund__accepts_valid() {
  let out = vault_output(make_fund(0, 0, 0, 0, Active), anchor_value(2_000_000))
  validate_create_fund(
    policy(),
    0,
    0,
    [seed_input(fund_seed_ref())],
    [out],
    create_mint(),
  )
}

test create_fund__rejects_wrong_token_name() {
  let out = vault_output(make_fund(0, 0, 0, 0, Active), anchor_value(2_000_000))
  let wrong_mint = assets.from_asset(policy(), #"beef", 1)
  !validate_create_fund(
    policy(),
    0,
    0,
    [seed_input(fund_seed_ref())],
    [out],
    wrong_mint,
  )
}

test create_fund__rejects_extra_mint() {
  let out = vault_output(make_fund(0, 0, 0, 0, Active), anchor_value(2_000_000))
  let extra = create_mint() |> assets.add(policy(), #"beef", 1)
  !validate_create_fund(
    policy(),
    0,
    0,
    [seed_input(fund_seed_ref())],
    [out],
    extra,
  )
}

test create_fund__rejects_foreign_token_in_anchor() {
  let stuffed = anchor_value(2_000_000)
    |> assets.add(common.token_policy(), common.token_name(), 5)
  let out = vault_output(make_fund(0, 0, 0, 0, Active), stuffed)
  !validate_create_fund(
    policy(),
    0,
    0,
    [seed_input(fund_seed_ref())],
    [out],
    create_mint(),
  )
}

test create_fund__rejects_nonzero_start() {
  let out = vault_output(active_fund(5), anchor_value(2_000_000))
  !validate_create_fund(
    policy(),
    0,
    0,
    [seed_input(fund_seed_ref())],
    [out],
    create_mint(),
  )
}

test create_fund__rejects_low_buffer() {
  let out = vault_output(make_fund(0, 0, 0, 0, Active), anchor_value(1_000_000))
  !validate_create_fund(
    policy(),
    0,
    0,
    [seed_input(fund_seed_ref())],
    [out],
    create_mint(),
  )
}

test create_fund__rejects_bad_band() fail {
  // min 0 violates charter sanity
  let bad = SavingsFund {
    title: #"",
    quorum: common.quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 0,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 1,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 0,
    savings_total: 0,
    social_total: 0,
    loans_outstanding: 0,
    status: Active,
  }
  let out = vault_output(bad, anchor_value(2_000_000))
  expect
    validate_create_fund(
      policy(),
      0,
      0,
      [seed_input(fund_seed_ref())],
      [out],
      create_mint(),
    )
}

test create_fund__rejects_own_policy_as_asset() fail {
  let bad = SavingsFund {
    title: #"",
    quorum: common.quorum_credential(),
    asset_policy: policy(),
    asset_name: #"544b4e",
    share_value: 1_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 1,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 0,
    savings_total: 0,
    social_total: 0,
    loans_outstanding: 0,
    status: Active,
  }
  let out = vault_output(bad, anchor_value(2_000_000))
  expect
    validate_create_fund(
      policy(),
      0,
      0,
      [seed_input(fund_seed_ref())],
      [out],
      create_mint(),
    )
}

test create_fund__rejects_sharing_out_start() fail {
  let bad = make_fund(
    0,
    0,
    0,
    0,
    SharingOut { pot: 1, shares: 1, shares_remaining: 1 },
  )
  let out = vault_output(bad, anchor_value(2_000_000))
  expect
    validate_create_fund(
      policy(),
      0,
      0,
      [seed_input(fund_seed_ref())],
      [out],
      create_mint(),
    )
}

// ── MintAccount (join) ──────────────────────────────────────────────────────

fn join_mint() {
  assets.from_asset(policy(), ref_name(), 1)
    |> assets.add(policy(), user_name(), 1)
}

fn fund_ref_input() -> Input {
  vault_input(9, vault_output(active_fund(0), anchor_value(2_000_000)))
}

fn join_ref_out() -> Output {
  vault_output(
    MemberAccount {
      fund_id: fund_name(),
      share_units: 0,
      social_paid: 0,
      borrowed: 0,
      consent: True,
      joined_at: 1_700_000_000_500,
    },
    member_ref_value(),
  )
}

fn join_user_out() -> Output {
  wallet_output(
    assets.from_lovelace(2_000_000) |> assets.add(policy(), user_name(), 1),
  )
}

fn join_range() {
  range_between(1_700_000_000_000, 1_700_000_900_000)
}

test mint_account__accepts_valid() {
  validate_mint_account(
    policy(),
    0,
    0,
    0,
    1,
    [seed_input(member_seed_ref())],
    [fund_ref_input()],
    [join_ref_out(), join_user_out()],
    join_mint(),
    join_range(),
  )
}

test mint_account__rejects_missing_user_token_mint() {
  let only_ref = assets.from_asset(policy(), ref_name(), 1)
  !validate_mint_account(
    policy(),
    0,
    0,
    0,
    1,
    [seed_input(member_seed_ref())],
    [fund_ref_input()],
    [join_ref_out(), join_user_out()],
    only_ref,
    join_range(),
  )
}

test mint_account__rejects_inactive_fund() {
  let closed = make_fund(
    0,
    0,
    0,
    0,
    SharingOut { pot: 5, shares: 5, shares_remaining: 5 },
  )
  let closed_ref = vault_input(9, vault_output(closed, anchor_value(2_000_000)))
  !validate_mint_account(
    policy(),
    0,
    0,
    0,
    1,
    [seed_input(member_seed_ref())],
    [closed_ref],
    [join_ref_out(), join_user_out()],
    join_mint(),
    join_range(),
  )
}

test mint_account__rejects_wrong_fund_id() {
  let bad_out = vault_output(
    MemberAccount {
      fund_id: #"beef",
      share_units: 0,
      social_paid: 0,
      borrowed: 0,
      consent: True,
      joined_at: 1_700_000_000_500,
    },
    member_ref_value(),
  )
  !validate_mint_account(
    policy(),
    0,
    0,
    0,
    1,
    [seed_input(member_seed_ref())],
    [fund_ref_input()],
    [bad_out, join_user_out()],
    join_mint(),
    join_range(),
  )
}

test mint_account__rejects_nonzero_units() {
  let bad_out = vault_output(
    MemberAccount {
      fund_id: fund_name(),
      share_units: 7,
      social_paid: 0,
      borrowed: 0,
      consent: True,
      joined_at: 1_700_000_000_500,
    },
    member_ref_value(),
  )
  !validate_mint_account(
    policy(),
    0,
    0,
    0,
    1,
    [seed_input(member_seed_ref())],
    [fund_ref_input()],
    [bad_out, join_user_out()],
    join_mint(),
    join_range(),
  )
}

test mint_account__rejects_user_token_to_script() {
  let to_script = vault_output(
    MemberAccount {
      fund_id: fund_name(),
      share_units: 0,
      social_paid: 0,
      borrowed: 0,
      consent: True,
      joined_at: 1_700_000_000_500,
    },
    assets.from_lovelace(2_000_000) |> assets.add(policy(), user_name(), 1),
  )
  !validate_mint_account(
    policy(),
    0,
    0,
    0,
    1,
    [seed_input(member_seed_ref())],
    [fund_ref_input()],
    [join_ref_out(), to_script],
    join_mint(),
    join_range(),
  )
}

test mint_account__rejects_joined_at_outside_window() {
  let stale = vault_output(
    MemberAccount {
      fund_id: fund_name(),
      share_units: 0,
      social_paid: 0,
      borrowed: 0,
      consent: True,
      joined_at: 1_600_000_000_000,
    },
    member_ref_value(),
  )
  !validate_mint_account(
    policy(),
    0,
    0,
    0,
    1,
    [seed_input(member_seed_ref())],
    [fund_ref_input()],
    [stale, join_user_out()],
    join_mint(),
    join_range(),
  )
}

test mint_account__rejects_wrong_suffix() {
  // Mint names derived from the FUND seed, not the consumed member seed.
  let forged = assets.from_asset(
    policy(),
    common.cip68_name_100(fund_seed_ref()),
    1,
  )
    |> assets.add(policy(), common.cip68_name_222(fund_seed_ref()), 1)
  !validate_mint_account(
    policy(),
    0,
    0,
    0,
    1,
    [seed_input(member_seed_ref())],
    [fund_ref_input()],
    [join_ref_out(), join_user_out()],
    forged,
    join_range(),
  )
}

// ── Burns ───────────────────────────────────────────────────────────────────

test burn_account__accepts_pair() {
  let burn = assets.from_asset(policy(), ref_name(), -1)
    |> assets.add(policy(), user_name(), -1)
  validate_burn_account(policy(), burn)
}

test burn_account__rejects_mismatched_suffixes() {
  let burn = assets.from_asset(policy(), ref_name(), -1)
    |> assets.add(policy(), common.cip68_name_222(fund_seed_ref()), -1)
  !validate_burn_account(policy(), burn)
}

test burn_account__rejects_single_burn() fail {
  let burn = assets.from_asset(policy(), ref_name(), -1)
  expect validate_burn_account(policy(), burn)
}

test burn_fund__accepts_state_token() {
  validate_burn_fund(policy(), assets.from_asset(policy(), fund_name(), -1))
}

test burn_fund__rejects_cip68_name() {
  !validate_burn_fund(policy(), assets.from_asset(policy(), ref_name(), -1))
}

test burn_fund__rejects_positive_mint() fail {
  expect
    validate_burn_fund(policy(), assets.from_asset(policy(), fund_name(), 1))
}
