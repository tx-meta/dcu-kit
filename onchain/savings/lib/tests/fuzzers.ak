use aiken/fuzz
use cardano/assets
use savings/types.{Active, SharingOut}
use savings/validation.{
  validate_claim_share_out, validate_close_cycle, validate_deposit,
  validate_withdraw,
}
use tests/common.{
  anchor_value, make_fund, make_member, member_ref_value, policy, quorum_tx,
  user_token_input, vault_input, vault_output,
}

// Any share purchase inside the band, matched by an exact delta, is accepted.
test prop_deposit_accepts_any_units_in_band(n via fuzz.int_between(1, 100)) {
  let f = make_fund(0, 15, 15_000_000, 0, Active)
  let a = vault_input(0, vault_output(f, anchor_value(17_000_000)))
  let m = vault_input(1, vault_output(make_member(10, 0), member_ref_value()))
  let delta = n * 1_000_000
  let fund_out = vault_output(
    make_fund(0, 15 + n, 15_000_000 + delta, 0, Active),
    anchor_value(17_000_000 + delta),
  )
  let member_out = vault_output(make_member(10 + n, 0), member_ref_value())
  validate_deposit(
    policy(),
    f,
    a,
    1,
    0,
    1,
    0,
    [a, m, user_token_input()],
    [fund_out, member_out],
    assets.zero,
  )
}

// A withdrawal above the member's balance is rejected, whatever the size.
test prop_withdraw_rejects_over_balance(extra via fuzz.int_between(1, 50)) {
  let units = 10 + extra
  let f = make_fund(1, 40, 40_000_000, 0, Active)
  let a = vault_input(0, vault_output(f, anchor_value(42_000_000)))
  let m = vault_input(1, vault_output(make_member(10, 0), member_ref_value()))
  let fund_out = vault_output(
    make_fund(1, 40 - units, ( 40 - units ) * 1_000_000, 0, Active),
    anchor_value(42_000_000 - units * 1_000_000),
  )
  let member_out = vault_output(make_member(10 - units, 0), member_ref_value())
  !validate_withdraw(
    policy(),
    f,
    a,
    1,
    0,
    1,
    [a, m, user_token_input()],
    [fund_out, member_out],
    assets.zero,
  )
}

// The frozen pot is exact: any other declared pot is rejected.
test prop_close_cycle_rejects_wrong_pot(off via fuzz.int_between(1, 5_000_000)) {
  let f = make_fund(0, 15, 15_000_000, 3_000_000, Active)
  let a = vault_input(0, vault_output(f, anchor_value(22_000_000)))
  // true pot = 22 - 3 social - 2 buffer = 17
  let wrong = make_fund(
    0,
    0,
    0,
    3_000_000,
    SharingOut { pot: 17_000_000 - off, shares: 15, shares_remaining: 15 },
  )
  let fund_out = vault_output(wrong, anchor_value(22_000_000))
  !validate_close_cycle(policy(), f, a, 0, [fund_out], assets.zero, quorum_tx())
}

// Floor-division claims: the exact floor payout is accepted for any
// units <= shares, and can never exceed the pot.
test prop_claim_floor_payout_accepted(units via fuzz.int_between(1, 15)) {
  let pot = 17_000_000
  let shares = 15
  let paid = pot * units / shares
  let sharing = make_fund(
    0,
    0,
    0,
    3_000_000,
    SharingOut { pot, shares, shares_remaining: shares },
  )
  let a = vault_input(0, vault_output(sharing, anchor_value(22_000_000)))
  let m = vault_input(
    1,
    vault_output(make_member(units, 0), member_ref_value()),
  )
  let after = make_fund(
    0,
    0,
    0,
    3_000_000,
    SharingOut { pot, shares, shares_remaining: shares - units },
  )
  let fund_out = vault_output(after, anchor_value(22_000_000 - paid))
  let member_out = vault_output(make_member(0, 0), member_ref_value())
  and {
    paid <= pot,
    validate_claim_share_out(
      policy(),
      sharing,
      a,
      1,
      0,
      1,
      [a, m, user_token_input()],
      [fund_out, member_out],
      assets.zero,
    ),
  }
}
