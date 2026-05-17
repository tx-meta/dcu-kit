use aiken/fuzz
use aiken/primitive/bytearray
use cardano/assets
use cardano/transaction.{Input, Output, OutputReference}
use dcu/cip68
use dcu/group.{
  GroupDatum, validate_create_group, validate_member_exit, validate_member_join,
  validate_remove_group, validate_update_group,
}
use tests/common
use tests/fuzzers.{gen_group_datum}

test create_group_success() {
  let policy_id = common.test_policy_id()
  // 1. Setup CIP-68 names & ref
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  // 2. Prepare Mint
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  // 3. Prepare Datum
  let datum = common.test_group_datum(policy_id)

  // 4. Build Output (must have Ref Token + Correct Addr + ADA for policy guard)
  let output_value =
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(policy_id, ref_tn, 1))
  let output = common.test_script_utxo(policy_id, output_value, datum)

  // 5. Build Input
  let input = common.test_input(output_ref, output)

  // 6. Build user token output at wallet address
  let user_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )

  let inputs = [input]
  let outputs = [output, user_output]

  // Expectation: returns True
  validate_create_group(policy_id, 0, 0, inputs, outputs, mint)
}

test create_group_invalid_fee() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let base_datum = common.test_group_datum(policy_id)
  let datum = GroupDatum { ..base_datum, contribution_fee: 0 }
  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_script_utxo(policy_id, output_value, datum)
  let input = common.test_input(output_ref, output)
  let user_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )

  !validate_create_group(policy_id, 0, 0, [input], [output, user_output], mint)
}

test create_group_invalid_member_count() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let base_datum = common.test_group_datum(policy_id)
  let datum = GroupDatum { ..base_datum, member_count: 1 }

  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_script_utxo(policy_id, output_value, datum)
  let input = common.test_input(output_ref, output)
  let user_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )

  !validate_create_group(policy_id, 0, 0, [input], [output, user_output], mint)
}

test create_group_invalid_intervals() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let base_datum = common.test_group_datum(policy_id)
  let datum = GroupDatum { ..base_datum, interval_length: 0 }

  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_script_utxo(policy_id, output_value, datum)
  let input = common.test_input(output_ref, output)
  let user_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )

  !validate_create_group(policy_id, 0, 0, [input], [output, user_output], mint)
}

test create_group_inactive() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let base_datum = common.test_group_datum(policy_id)
  let datum = GroupDatum { ..base_datum, is_active: False }

  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_script_utxo(policy_id, output_value, datum)
  let input = common.test_input(output_ref, output)
  let user_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )

  !validate_create_group(policy_id, 0, 0, [input], [output, user_output], mint)
}

// expect Some(1) = dict.get(...) crashes when token name not found — use fail without !
test create_group_wrong_token_names() fail {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, _user_tn) = common.setup_cip68(policy_id)
  let datum = common.test_group_datum(policy_id)
  // Use a WRONG suffix to simulate mismatch
  let wrong_suffix =
    #"badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad"
  let wrong_ref_tn = cip68.prefix_100 |> bytearray.concat(wrong_suffix)
  let wrong_user_tn = cip68.prefix_222 |> bytearray.concat(wrong_suffix)
  let mint =
    assets.from_asset(policy_id, wrong_ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, wrong_user_tn, 1))
  // Even if we put the 'correct' ref token in output (unlikely scenario but possible if mismatched),
  // validation should fail on mint check first.
  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_script_utxo(policy_id, output_value, datum)
  let input = common.test_input(output_ref, output)

  validate_create_group(policy_id, 0, 0, [input], [output], mint)
}

// expect Some(1) = Some(2) crashes when qty != 1 — use fail without !
test create_group_wrong_mint_quantity() fail {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let datum = common.test_group_datum(policy_id)

  // Invalid: Minting 2 Reference Tokens instead of 1
  let invalid_mint =
    assets.from_asset(policy_id, ref_tn, 2)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))
  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_script_utxo(policy_id, output_value, datum)
  let input = common.test_input(output_ref, output)

  validate_create_group(policy_id, 0, 0, [input], [output], invalid_mint)
}

test create_group_wrong_output_address_fails() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let datum = common.test_group_datum(policy_id)
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  // FAILURE CASE: Wrong Address (not script address)
  let output = common.test_user_utxo(common.test_pkh(), output_value, datum)
  let input = common.test_input(output_ref, output)
  let user_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )

  !validate_create_group(policy_id, 0, 0, [input], [output, user_output], mint)
}

test create_group_missing_ref_token_fails() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let datum = common.test_group_datum(policy_id)
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  // FAILURE CASE: Output has NO value (missing ref token)
  let output_value = assets.zero
  let output = common.test_script_utxo(policy_id, output_value, datum)
  let input = common.test_input(output_ref, output)
  let user_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )

  !validate_create_group(policy_id, 0, 0, [input], [output, user_output], mint)
}

// --- Update Group Tests ---

test update_group_success() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let base_datum = common.test_group_datum(policy_id)
  // Initial State: member_count = 0 (from test_group_datum)
  let group_input_utxo =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      base_datum,
    )
  let group_input = common.test_input(output_ref, group_input_utxo)

  let admin_input_utxo =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      base_datum,
    )
  let admin_input = common.test_input(output_ref, admin_input_utxo)

  // Update: Change fee
  let updated_datum = GroupDatum { ..base_datum, contribution_fee: 2000 }
  let group_output_utxo =
    common.test_script_utxo(
      policy_id,
      assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(policy_id, ref_tn, 1)),
      updated_datum,
    )

  let inputs = [group_input, admin_input]
  let outputs = [group_output_utxo]

  validate_update_group(
    policy_id,
    ref_tn,
    1,
    // admin_input_index
    0,
    // group_input_index
    0,
    // group_output_index
    inputs,
    outputs,
  )
}

test update_group_fail_auth() fail {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, _user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)
  let group_input_utxo =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      base_datum,
    )
  let group_input = common.test_input(output_ref, group_input_utxo)

  // Admin has WRONG token (or no token)
  let admin_input_utxo =
    common.test_user_utxo(common.test_pkh(), assets.zero, base_datum)
  let admin_input = common.test_input(output_ref, admin_input_utxo)

  let updated_datum = GroupDatum { ..base_datum, contribution_fee: 2000 }
  let group_output_utxo =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      updated_datum,
    )

  !validate_update_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output_utxo],
  )
}

test update_group_fail_active() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  // Active Group with Members
  let base_datum =
    GroupDatum { ..common.test_group_datum(policy_id), member_count: 5 }
  let group_input_utxo =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      base_datum,
    )
  let group_input = common.test_input(output_ref, group_input_utxo)

  let admin_input_utxo =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      base_datum,
    )
  let admin_input = common.test_input(output_ref, admin_input_utxo)

  // Critical Update on Active Group -> Should Fail
  let updated_datum = GroupDatum { ..base_datum, contribution_fee: 2000 }
  let group_output_utxo =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      updated_datum,
    )

  !validate_update_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output_utxo],
  )
}

test update_group_fail_change_members() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)
  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_asset(policy_id, ref_tn, 1),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Try to manually increment member count via Update (Not Allowed)
  let updated_datum = GroupDatum { ..base_datum, member_count: 1 }
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      updated_datum,
    )

  !validate_update_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

test update_group_wrong_output_address_fails() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)

  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_asset(policy_id, ref_tn, 1),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Fail: Send to wrong address
  let group_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, ref_tn, 1),
      base_datum,
    )

  !validate_update_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

test update_group_missing_ref_token_fails() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)

  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_asset(policy_id, ref_tn, 1),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Fail: Missing Ref Token
  let group_output = common.test_script_utxo(policy_id, assets.zero, base_datum)

  !validate_update_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

test update_group_fail_deactivate() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)

  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_asset(policy_id, ref_tn, 1),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Fail: Cannot deactivate via Update (use RemoveGroup)
  let updated_datum = GroupDatum { ..base_datum, is_active: False }
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      updated_datum,
    )

  !validate_update_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

// --- Remove Group Tests ---

test remove_group_success() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)
  // member_count = 0
  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_asset(policy_id, ref_tn, 1),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  let updated_datum = GroupDatum { ..base_datum, is_active: False }
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(policy_id, ref_tn, 1)),
      updated_datum,
    )

  validate_remove_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

test remove_group_fail_members() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum =
    GroupDatum { ..common.test_group_datum(policy_id), member_count: 1 }
  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_asset(policy_id, ref_tn, 1),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  let updated_datum = GroupDatum { ..base_datum, is_active: False }
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      updated_datum,
    )

  !validate_remove_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

test remove_group_wrong_output_address_fails() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)

  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_asset(policy_id, ref_tn, 1),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Fail: Wrong address
  let updated_datum = GroupDatum { ..base_datum, is_active: False }
  let group_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, ref_tn, 1),
      updated_datum,
    )

  !validate_remove_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

test remove_group_missing_ref_token_fails() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)

  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_asset(policy_id, ref_tn, 1),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Fail: Missing ref token
  let updated_datum = GroupDatum { ..base_datum, is_active: False }
  let group_output =
    common.test_script_utxo(policy_id, assets.zero, updated_datum)

  !validate_remove_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

test remove_group_fail_active() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)

  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_asset(policy_id, ref_tn, 1),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Fail: Still active (Remove MUST deactivate)
  let updated_datum = GroupDatum { ..base_datum, is_active: True }
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      updated_datum,
    )

  !validate_remove_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

// --- Property Tests ---

test prop_create_group_integrity(datum via gen_group_datum()) {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  // Construct valid Mint and UTxOs around the random datum
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  // Include ADA so the output policy guard [ada_policy_id, policy_id] passes for valid datums
  let output_value =
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(policy_id, ref_tn, 1))
  let output = common.test_script_utxo(policy_id, output_value, datum)
  let input = common.test_input(output_ref, output)
  let user_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )

  // Define what makes a datum "Invalid"
  let is_invalid =
    datum.contribution_fee <= 0 || datum.joining_fee < 0 || datum.penalty_fee < 0 || datum.interval_length <= 0 || datum.num_intervals <= 0 || datum.num_intervals > 100 || datum.max_members <= 0 || datum.member_count != 0 || !datum.is_active || bytearray.length(
      datum.admin_payment_credential,
    ) != 28

  // The Property:
  // If the datum is invalid, validation MUST return False.
  // If the datum happens to be valid (rare but possible), we expect True.
  if is_invalid {
    !validate_create_group(
      policy_id,
      0,
      0,
      [input],
      [output, user_output],
      mint,
    )
  } else {
    validate_create_group(policy_id, 0, 0, [input], [output, user_output], mint)
  }
}

// --- Security: num_intervals bound ---

test create_group__rejects_excessive_num_intervals() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  // num_intervals = 101 exceeds the 100-interval cap
  let datum =
    GroupDatum { ..common.test_group_datum(policy_id), num_intervals: 101 }
  let output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      datum,
    )
  let input = common.test_input(output_ref, output)
  let user_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )

  !validate_create_group(policy_id, 0, 0, [input], [output, user_output], mint)
}

test create_group__rejects_zero_max_members() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  // max_members = 0 is invalid — a group with zero capacity cannot accept any member
  let datum =
    GroupDatum { ..common.test_group_datum(policy_id), max_members: 0 }
  let output =
    common.test_script_utxo(
      policy_id,
      assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(policy_id, ref_tn, 1)),
      datum,
    )
  let input = common.test_input(output_ref, output)
  let user_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )

  !validate_create_group(policy_id, 0, 0, [input], [output, user_output], mint)
}

// admin_payment_credential shorter than 28 bytes — bytearray.length check fails
test create_group__rejects_invalid_admin_payment_credential() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  // 27 bytes — one byte short of the required 28
  let datum =
    GroupDatum {
      ..common.test_group_datum(policy_id),
      admin_payment_credential: #"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbcc",
    }
  let output =
    common.test_script_utxo(
      policy_id,
      assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(policy_id, ref_tn, 1),
      ),
      datum,
    )
  let input = common.test_input(output_ref, output)
  let user_output =
    common.test_user_utxo(
      common.test_pkh(),
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )

  !validate_create_group(policy_id, 0, 0, [input], [output, user_output], mint)
}

// --- Security: fee currency freeze (is_critical_update with members) ---

test update_group__rejects_fee_currency_change_with_members() {
  let policy_id = common.test_policy_id()
  let alt_policy_id = common.test_hash_03()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  // Group has 3 members — critical fields must be frozen
  let base_datum =
    GroupDatum { ..common.test_group_datum(policy_id), member_count: 3 }
  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_asset(policy_id, ref_tn, 1),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Attempt to switch contribution_fee currency — economic rug-pull
  let updated_datum =
    GroupDatum { ..base_datum, contribution_fee_policyid: alt_policy_id }
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      updated_datum,
    )

  !validate_update_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

// --- Security: ADA preservation on update ---

test update_group__rejects_ada_drain() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)

  // Input has 5 ADA locked alongside the ref token
  let group_input_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(policy_id, ref_tn, 1))
  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(policy_id, group_input_value, base_datum),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Output only returns the ref token — ADA drained
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      base_datum,
    )

  !validate_update_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

// --- Security: ADA preservation on remove ---

test remove_group__rejects_ada_drain() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)

  // Input has 5 ADA locked alongside the ref token
  let group_input_value =
    assets.from_lovelace(5_000_000)
      |> assets.merge(assets.from_asset(policy_id, ref_tn, 1))
  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(policy_id, group_input_value, base_datum),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Output only returns the ref token — ADA drained
  let updated_datum = GroupDatum { ..base_datum, is_active: False }
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      updated_datum,
    )

  !validate_remove_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

// --- Security: exact datum equality on remove (no silent field changes) ---

test remove_group__rejects_simultaneous_field_change() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let base_datum = common.test_group_datum(policy_id)

  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_asset(policy_id, ref_tn, 1),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Admin flips is_active AND silently raises the contribution_fee — must be rejected
  let updated_datum =
    GroupDatum {
      ..base_datum,
      is_active: False,
      contribution_fee: base_datum.contribution_fee * 10,
    }
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      updated_datum,
    )

  !validate_remove_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

// --- Security: user token must go to a wallet, not a script ---

test create__rejects_user_token_to_script() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let mint =
    assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let datum = common.test_group_datum(policy_id)
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      datum,
    )
  // User token sent to a script address — admin authority permanently lost
  let user_output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, user_tn, 1),
      datum,
    )
  let input = common.test_input(output_ref, group_output)

  !validate_create_group(
    policy_id,
    0,
    0,
    [input],
    [group_output, user_output],
    mint,
  )
}

// --- Property: update rejects critical field change when members are active ---
//
// NOTE: group input and output include ADA so output_clean_value and out_ada >= in_ada
// both pass. The property exercises is_safe_update exclusively: any fee change with
// member_count > 0 must be rejected regardless of the new fee value.

test prop_update_group__rejects_critical_change_with_members(
  new_fee via fuzz.int_at_least(1),
) {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  let base_datum =
    GroupDatum { ..common.test_group_datum(policy_id), member_count: 1 }
  let group_input =
    common.test_input(
      output_ref,
      common.test_script_utxo(
        policy_id,
        assets.from_lovelace(2_000_000)
          |> assets.merge(assets.from_asset(policy_id, ref_tn, 1)),
        base_datum,
      ),
    )
  let admin_input =
    common.test_input(
      output_ref,
      common.test_user_utxo(
        common.test_pkh(),
        assets.from_asset(policy_id, user_tn, 1),
        base_datum,
      ),
    )

  // Any change to contribution_fee is a critical update — blocked with members.
  // base_datum.contribution_fee + new_fee >= base_fee + 1, so it always differs
  // from base_datum.contribution_fee regardless of the base value.
  let updated_datum =
    GroupDatum {
      ..base_datum,
      contribution_fee: base_datum.contribution_fee + new_fee,
    }
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_lovelace(2_000_000)
        |> assets.merge(assets.from_asset(policy_id, ref_tn, 1)),
      updated_datum,
    )

  !validate_update_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

// ─── validate_member_join ─────────────────────────────────────────────────────

// Treasury policy — distinct from the group policy
fn treasury_policy_id() -> assets.PolicyId {
  common.test_hash_03()
}

// Group input holding the ref token with the given member_count
fn group_input_with_count(
  policy_id: assets.PolicyId,
  ref_tn: ByteArray,
  member_count: Int,
) -> Input {
  let datum = GroupDatum { ..common.test_group_datum(policy_id), member_count }
  // Include 2 ADA so the ADA preservation check (out_ada >= in_ada) is non-trivial
  let value =
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(policy_id, ref_tn, 1))
  let output = common.test_script_utxo(policy_id, value, datum)
  common.test_input(
    OutputReference {
      transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
      output_index: 0,
    },
    output,
  )
}

// Group output holding the ref token with the given member_count.
// Includes 2 ADA so the output policy guard [ada_policy_id, policy_id] passes.
fn group_output_with_count(
  policy_id: assets.PolicyId,
  ref_tn: ByteArray,
  member_count: Int,
) -> Output {
  let datum = GroupDatum { ..common.test_group_datum(policy_id), member_count }
  let value =
    assets.from_lovelace(2_000_000)
      |> assets.merge(assets.from_asset(policy_id, ref_tn, 1))
  common.test_script_utxo(policy_id, value, datum)
}

// MemberJoin: first member joins — member_count 0 → 1
test member_join__accepts_valid_join() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)
  let tp = treasury_policy_id()

  let group_in = group_input_with_count(policy_id, ref_tn, 0)
  let group_out = group_output_with_count(policy_id, ref_tn, 1)

  // Treasury minting exactly 1 token proves JoinGroup ran
  let mint = assets.from_asset(tp, #"aabb", 1)

  validate_member_join(
    policy_id,
    tp,
    ref_tn,
    0,
    0,
    [group_in],
    [group_out],
    mint,
  )
}

// MemberJoin: second member joins — member_count 1 → 2
test member_join__accepts_second_member() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)
  let tp = treasury_policy_id()

  let group_in = group_input_with_count(policy_id, ref_tn, 1)
  let group_out = group_output_with_count(policy_id, ref_tn, 2)
  let mint = assets.from_asset(tp, #"aabb", 1)

  validate_member_join(
    policy_id,
    tp,
    ref_tn,
    0,
    0,
    [group_in],
    [group_out],
    mint,
  )
}

// MemberJoin: no treasury mint — proves JoinGroup did NOT run → rejected
test member_join__rejects_no_treasury_mint() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)
  let tp = treasury_policy_id()

  let group_in = group_input_with_count(policy_id, ref_tn, 0)
  let group_out = group_output_with_count(policy_id, ref_tn, 1)
  // Mint is empty — no treasury token minted
  let mint = assets.zero

  !validate_member_join(
    policy_id,
    tp,
    ref_tn,
    0,
    0,
    [group_in],
    [group_out],
    mint,
  )
}

// MemberJoin: group output has wrong member_count (not incremented) → rejected
test member_join__rejects_member_count_not_incremented() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)
  let tp = treasury_policy_id()

  let group_in = group_input_with_count(policy_id, ref_tn, 0)
  // Output: member_count still 0 — not incremented
  let group_out = group_output_with_count(policy_id, ref_tn, 0)
  let mint = assets.from_asset(tp, #"aabb", 1)

  !validate_member_join(
    policy_id,
    tp,
    ref_tn,
    0,
    0,
    [group_in],
    [group_out],
    mint,
  )
}

// MemberJoin: group output has over-incremented member_count → rejected
test member_join__rejects_member_count_over_incremented() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)
  let tp = treasury_policy_id()

  let group_in = group_input_with_count(policy_id, ref_tn, 0)
  // Output: member_count = 2 (skipped 1) — rejected
  let group_out = group_output_with_count(policy_id, ref_tn, 2)
  let mint = assets.from_asset(tp, #"aabb", 1)

  !validate_member_join(
    policy_id,
    tp,
    ref_tn,
    0,
    0,
    [group_in],
    [group_out],
    mint,
  )
}

// ─── validate_member_exit ─────────────────────────────────────────────────────

// MemberExit: mature exit — member_count 1 → 0 (token burned by treasury)
test member_exit__accepts_valid_exit() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)

  let group_in = group_input_with_count(policy_id, ref_tn, 1)
  let group_out = group_output_with_count(policy_id, ref_tn, 0)

  validate_member_exit(policy_id, ref_tn, 0, 0, [group_in], [group_out])
}

// MemberExit: member_count 2 → 1 (partial exit with remaining members)
test member_exit__accepts_partial_exit() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)

  let group_in = group_input_with_count(policy_id, ref_tn, 2)
  let group_out = group_output_with_count(policy_id, ref_tn, 1)

  validate_member_exit(policy_id, ref_tn, 0, 0, [group_in], [group_out])
}

// MemberExit: group output member_count not decremented → rejected
test member_exit__rejects_member_count_not_decremented() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)

  let group_in = group_input_with_count(policy_id, ref_tn, 1)
  // Output: member_count still 1 — not decremented
  let group_out = group_output_with_count(policy_id, ref_tn, 1)

  !validate_member_exit(policy_id, ref_tn, 0, 0, [group_in], [group_out])
}

// MemberExit: cannot exit when member_count == 0 (expect crashes)
test member_exit__rejects_exit_when_no_members() fail {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)

  let group_in = group_input_with_count(policy_id, ref_tn, 0)
  let group_out = group_output_with_count(policy_id, ref_tn, -1)

  // expect current.member_count >= 1 crashes when member_count == 0
  validate_member_exit(policy_id, ref_tn, 0, 0, [group_in], [group_out])
}

// Group input holds 5M ADA; member_join output returns only ref token — ADA drained
test member_join__rejects_group_ada_drain() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)
  let tp = treasury_policy_id()

  let base_datum =
    GroupDatum { ..common.test_group_datum(policy_id), member_count: 0 }
  let group_in =
    common.test_input(
      OutputReference {
        transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
        output_index: 0,
      },
      common.test_script_utxo(
        policy_id,
        assets.from_lovelace(5_000_000)
          |> assets.merge(assets.from_asset(policy_id, ref_tn, 1)),
        base_datum,
      ),
    )
  // Output: member_count incremented but ADA stripped — out_ada (0) < in_ada (5M)
  let group_out =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      GroupDatum { ..base_datum, member_count: 1 },
    )
  let mint = assets.from_asset(tp, #"aa", 1)

  !validate_member_join(
    policy_id,
    tp,
    ref_tn,
    0,
    0,
    [group_in],
    [group_out],
    mint,
  )
}

// Group input holds 5M ADA; member_exit output returns only ref token — ADA drained
test member_exit__rejects_group_ada_drain() {
  let policy_id = common.test_policy_id()
  let (_, ref_tn, _) = common.setup_cip68(policy_id)

  let base_datum =
    GroupDatum { ..common.test_group_datum(policy_id), member_count: 1 }
  let group_in =
    common.test_input(
      OutputReference {
        transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
        output_index: 0,
      },
      common.test_script_utxo(
        policy_id,
        assets.from_lovelace(5_000_000)
          |> assets.merge(assets.from_asset(policy_id, ref_tn, 1)),
        base_datum,
      ),
    )
  // Output: member_count decremented but ADA stripped — out_ada (0) < in_ada (5M)
  let group_out =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      GroupDatum { ..base_datum, member_count: 0 },
    )

  !validate_member_exit(policy_id, ref_tn, 0, 0, [group_in], [group_out])
}
