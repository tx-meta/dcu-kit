use aiken/primitive/bytearray
use cardano/assets
use cardano/transaction.{OutputReference}
use dcu/account.{
  AccountDatum, is_account_datum_valid, validate_burn_account,
  validate_close_account, validate_create_account, validate_update_account,
}
use dcu/cip68
use tests/common
use tests/fuzzers.{gen_account_datum}

// ─── Shared helpers ───────────────────────────────────────────────────────────

// Real account UTxOs always carry ADA. Merge min ADA into a token value so that
// the output policy guard `policies(v) == [ada_policy_id, policy_id]` passes.
fn with_min_ada(value: assets.Value) -> assets.Value {
  assets.merge(assets.from_lovelace(2_000_000), value)
}

fn valid_display_name() {
  bytearray.take(
    #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    32,
  )
}

fn valid_contact() {
  bytearray.take(
    #"2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40",
    32,
  )
}

fn test_account_datum() -> AccountDatum {
  AccountDatum { display_name: valid_display_name(), contact: valid_contact() }
}

// ─── is_account_datum_valid ───────────────────────────────────────────────────

test datum_valid__both_hashes() {
  is_account_datum_valid(test_account_datum())
}

test datum_valid__display_name_only() {
  let datum = AccountDatum {
    display_name: valid_display_name(),
    // contact is too short — invalid
    contact: #"aabb",
  }
  is_account_datum_valid(datum)
}

test datum_valid__contact_only() {
  let datum = AccountDatum {
    // display_name is empty — invalid
    display_name: #"",
    contact: valid_contact(),
  }
  is_account_datum_valid(datum)
}

test datum_invalid__both_empty() {
  let datum = AccountDatum { display_name: #"", contact: #"" }
  !is_account_datum_valid(datum)
}

// ─── validate_create_account ─────────────────────────────────────────────────

test create_account_success() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let mint = assets.from_asset(policy_id, ref_tn, 1)
    |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let datum = test_account_datum()
  let ref_output = common.test_script_utxo(
    policy_id,
    with_min_ada(assets.from_asset(policy_id, ref_tn, 1)),
    datum,
  )
  let user_output = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let input = common.test_input(output_ref, ref_output)

  validate_create_account(
    policy_id,
    0,
    0,
    [input],
    [ref_output, user_output],
    mint,
  )
}

test create_account_rejects_invalid_datum() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let mint = assets.from_asset(policy_id, ref_tn, 1)
    |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  // Both hashes are empty — invalid datum
  let bad_datum = AccountDatum { display_name: #"", contact: #"" }
  let ref_output = common.test_script_utxo(
    policy_id,
    with_min_ada(assets.from_asset(policy_id, ref_tn, 1)),
    bad_datum,
  )
  let user_output = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    bad_datum,
  )
  let input = common.test_input(output_ref, ref_output)

  !validate_create_account(
    policy_id,
    0,
    0,
    [input],
    [ref_output, user_output],
    mint,
  )
}

// expect crash — minting 2 of ref token causes `expect Some(1) = dict.get(...)` to fail
test create_account_rejects_wrong_mint_quantity() fail {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let mint = assets.from_asset(policy_id, ref_tn, 2)
    |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let datum = test_account_datum()
  let ref_output = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 2),
    datum,
  )
  let user_output = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let input = common.test_input(output_ref, ref_output)

  validate_create_account(
    policy_id,
    0,
    0,
    [input],
    [ref_output, user_output],
    mint,
  )
}

// expect crash — missing user token causes `expect Some(1) = dict.get(minted_tokens, user_token_name)` to fail
test create_account_rejects_missing_user_token() fail {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, _user_tn) = common.setup_cip68(policy_id)

  let mint = assets.from_asset(policy_id, ref_tn, 1)

  let datum = test_account_datum()
  let ref_output = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )
  let input = common.test_input(output_ref, ref_output)

  validate_create_account(policy_id, 0, 0, [input], [ref_output], mint)
}

test create_account_rejects_ref_token_to_wallet() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let mint = assets.from_asset(policy_id, ref_tn, 1)
    |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let datum = test_account_datum()
  // Ref token sent to wallet instead of script
  let wallet_ref = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )
  let user_output = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let input = common.test_input(output_ref, wallet_ref)

  !validate_create_account(
    policy_id,
    0,
    0,
    [input],
    [wallet_ref, user_output],
    mint,
  )
}

test create_account_rejects_user_token_to_script() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let mint = assets.from_asset(policy_id, ref_tn, 1)
    |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let datum = test_account_datum()
  let ref_output = common.test_script_utxo(
    policy_id,
    with_min_ada(assets.from_asset(policy_id, ref_tn, 1)),
    datum,
  )
  // User token also sent to script — account authority permanently locked
  let user_at_script = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let input = common.test_input(output_ref, ref_output)

  !validate_create_account(
    policy_id,
    0,
    0,
    [input],
    [ref_output, user_at_script],
    mint,
  )
}

// ─── validate_burn_account ─────────────────────────────────────────────────

test burn_account_success() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let mint = assets.from_asset(policy_id, ref_tn, -1)
    |> assets.merge(assets.from_asset(policy_id, user_tn, -1))

  validate_burn_account(policy_id, ref_tn, mint)
}

// expect crash — missing user token burn causes `expect Some(-1) = dict.get(minted_tokens, user_token_name)` to fail
test burn_account_rejects_partial_burn() fail {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)

  let mint = assets.from_asset(policy_id, ref_tn, -1)

  validate_burn_account(policy_id, ref_tn, mint)
}

// expect crash — burning qty -2 causes `expect Some(-1) = dict.get(minted_tokens, reference_token_name)` to fail
test burn_account_rejects_wrong_burn_amount() fail {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let mint = assets.from_asset(policy_id, ref_tn, -2)
    |> assets.merge(assets.from_asset(policy_id, user_tn, -1))

  validate_burn_account(policy_id, ref_tn, mint)
}

test burn_account_rejects_extra_token_minted() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, user_tn) = common.setup_cip68(policy_id)

  // A second ref-style token name derived from a different hash
  let extra_tn = bytearray.concat(cip68.prefix_100, common.test_hash_03())

  // Burning the correct pair but also minting an extra token under the same policy
  let mint = assets.from_asset(policy_id, ref_tn, -1)
    |> assets.merge(assets.from_asset(policy_id, user_tn, -1))
    |> assets.merge(assets.from_asset(policy_id, extra_tn, 1))

  !validate_burn_account(policy_id, ref_tn, mint)
}

// ─── validate_update_account ─────────────────────────────────────────────────

test update_account_success() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let old_datum = test_account_datum()
  let new_datum = AccountDatum {
    display_name: valid_display_name(),
    contact: valid_contact(),
  }

  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    old_datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  let user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    old_datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    user_utxo,
  )

  let updated_output = common.test_script_utxo(
    policy_id,
    with_min_ada(assets.from_asset(policy_id, ref_tn, 1)),
    new_datum,
  )

  validate_update_account(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [account_input, user_input],
    [updated_output],
  )
}

test update_account_rejects_no_user_token() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, _) = common.setup_cip68(policy_id)

  let datum = test_account_datum()
  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  // User input carries ADA only — no user token
  let empty_user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_lovelace(2000000),
    datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    empty_user_utxo,
  )

  let updated_output = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )

  !validate_update_account(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [account_input, user_input],
    [updated_output],
  )
}

test update_account_rejects_wrong_output_address() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let datum = test_account_datum()
  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  let user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    user_utxo,
  )

  // Output goes to wallet instead of the script address
  let wrong_output = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )

  !validate_update_account(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [account_input, user_input],
    [wrong_output],
  )
}

test update_account_rejects_missing_ref_token_in_output() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let datum = test_account_datum()
  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  let user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    user_utxo,
  )

  // Output at script but ref token missing
  let output_no_token = common.test_script_utxo(
    policy_id,
    assets.from_lovelace(2000000),
    datum,
  )

  !validate_update_account(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [account_input, user_input],
    [output_no_token],
  )
}

// ─── validate_close_account ─────────────────────────────────────────────────

test close_account_success() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let datum = test_account_datum()
  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  let user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    user_utxo,
  )

  let mint = assets.from_asset(policy_id, ref_tn, -1)

  validate_close_account(
    policy_id,
    ref_tn,
    1,
    0,
    [account_input, user_input],
    mint,
  )
}

test close_account_rejects_no_user_token() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, _) = common.setup_cip68(policy_id)

  let datum = test_account_datum()
  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  // User input carries no user token
  let empty_user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_lovelace(2000000),
    datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    empty_user_utxo,
  )

  let mint = assets.from_asset(policy_id, ref_tn, -1)

  !validate_close_account(
    policy_id,
    ref_tn,
    1,
    0,
    [account_input, user_input],
    mint,
  )
}

test close_account_rejects_no_burn() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let datum = test_account_datum()
  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  let user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    user_utxo,
  )

  // No burn at all
  let mint = assets.zero

  !validate_close_account(
    policy_id,
    ref_tn,
    1,
    0,
    [account_input, user_input],
    mint,
  )
}

test close_account_rejects_missing_ref_token_in_input() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let datum = test_account_datum()
  // Account input has no ref token
  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_lovelace(2000000),
    datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  let user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    user_utxo,
  )

  let mint = assets.from_asset(policy_id, ref_tn, -1)

  !validate_close_account(
    policy_id,
    ref_tn,
    1,
    0,
    [account_input, user_input],
    mint,
  )
}

// ─── Output value safety tests ────────────────────────────────────────────────

test create__rejects_extra_policy_in_output() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let mint = assets.from_asset(policy_id, ref_tn, 1)
    |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let datum = test_account_datum()
  // Ref output holds ADA + ref token + a token from a foreign policy
  let foreign_policy = common.test_hash_03()
  let foreign_token = bytearray.concat(cip68.prefix_100, common.test_hash_02())
  let ref_output = common.test_script_utxo(
    policy_id,
    with_min_ada(assets.from_asset(policy_id, ref_tn, 1))
      |> assets.merge(assets.from_asset(foreign_policy, foreign_token, 1)),
    datum,
  )
  let user_output = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let input = common.test_input(output_ref, ref_output)

  !validate_create_account(
    policy_id,
    0,
    0,
    [input],
    [ref_output, user_output],
    mint,
  )
}

test update__rejects_extra_policy_in_output() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let datum = test_account_datum()
  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  let user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    user_utxo,
  )

  // Output holds ADA + ref token + a token from a foreign policy
  let foreign_policy = common.test_hash_03()
  let foreign_token = bytearray.concat(cip68.prefix_100, common.test_hash_02())
  let polluted_output = common.test_script_utxo(
    policy_id,
    with_min_ada(assets.from_asset(policy_id, ref_tn, 1))
      |> assets.merge(assets.from_asset(foreign_policy, foreign_token, 1)),
    datum,
  )

  !validate_update_account(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [account_input, user_input],
    [polluted_output],
  )
}

// [spec UpdateAccount 4] — two accounts updated in one tx must not share one output
test update__rejects_shared_output_for_two_accounts() {
  let policy_id = common.test_policy_id()
  let (output_ref_a, ref_tn_a, user_tn_a) = common.setup_cip68(policy_id)

  // Derive a second distinct CIP-68 pair from a different output reference
  let output_ref_b = OutputReference {
    transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
    output_index: 0,
  }
  let ref_tn_b = cip68.unique_token_name(output_ref_b, cip68.prefix_100)
  let user_tn_b = cip68.unique_token_name(output_ref_b, cip68.prefix_222)

  let datum = test_account_datum()

  let account_a = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn_a, 1),
    datum,
  )
  let account_b = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn_b, 1),
    datum,
  )
  let input_a = common.test_input(output_ref_a, account_a)
  let input_b = common.test_input(output_ref_b, account_b)

  let user_a = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn_a, 1),
    datum,
  )
  let user_b = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn_b, 1),
    datum,
  )
  let user_input_a = common.test_input(
    common.placeholder_input.output_reference,
    user_a,
  )
  let user_input_b = common.test_input(
    common.placeholder_input.output_reference,
    user_b,
  )

  // Single merged output carrying BOTH ref tokens — the account-merge attack
  let merged_output = common.test_script_utxo(
    policy_id,
    with_min_ada(
      assets.from_asset(policy_id, ref_tn_a, 1)
        |> assets.merge(assets.from_asset(policy_id, ref_tn_b, 1)),
    ),
    datum,
  )

  // Account A's validator: dict.to_pairs finds [ref_tn_a, ref_tn_b] ≠ [ref_tn_a] → False
  !validate_update_account(
    policy_id,
    ref_tn_a,
    2,
    0,
    0,
    [input_a, input_b, user_input_a, user_input_b],
    [merged_output],
  )
}

// ─── Remaining test-gap coverage ──────────────────────────────────────────────

test update__rejects_invalid_output_datum() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let datum = test_account_datum()
  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  let user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    user_utxo,
  )

  // Output datum has both hashes empty — fails is_account_datum_valid
  let bad_datum = AccountDatum { display_name: #"", contact: #"" }
  let output_bad_datum = common.test_script_utxo(
    policy_id,
    with_min_ada(assets.from_asset(policy_id, ref_tn, 1)),
    bad_datum,
  )

  !validate_update_account(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [account_input, user_input],
    [output_bad_datum],
  )
}

test update__rejects_missing_ref_token_in_account_input() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let datum = test_account_datum()
  // Account input has ADA only — no ref token
  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_lovelace(2_000_000),
    datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  let user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    user_utxo,
  )

  let updated_output = common.test_script_utxo(
    policy_id,
    with_min_ada(assets.from_asset(policy_id, ref_tn, 1)),
    datum,
  )

  !validate_update_account(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [account_input, user_input],
    [updated_output],
  )
}

test remove__rejects_wrong_ref_token_burn_amount() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let datum = test_account_datum()
  let account_utxo = common.test_script_utxo(
    policy_id,
    assets.from_asset(policy_id, ref_tn, 1),
    datum,
  )
  let account_input = common.test_input(output_ref, account_utxo)

  let user_utxo = common.test_user_utxo(
    common.test_pkh(),
    assets.from_asset(policy_id, user_tn, 1),
    datum,
  )
  let user_input = common.test_input(
    common.placeholder_input.output_reference,
    user_utxo,
  )

  // Burn qty -2 instead of -1
  let mint = assets.from_asset(policy_id, ref_tn, -2)

  !validate_close_account(
    policy_id,
    ref_tn,
    1,
    0,
    [account_input, user_input],
    mint,
  )
}

// ─── Property tests ───────────────────────────────────────────────────────────

test prop_create_account_datum_validity(datum via gen_account_datum()) {
  let name_valid = bytearray.length(datum.display_name) > 0
  let contact_valid = bytearray.length(datum.contact) > 0
  let expected = name_valid || contact_valid
  is_account_datum_valid(datum) == expected
}
