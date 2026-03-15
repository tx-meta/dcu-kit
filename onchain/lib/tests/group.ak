use aiken/fuzz
use aiken/primitive/bytearray
use cardano/assets
use dcu/cip68
use dcu/group.{
  GroupDatum, validate_create_group, validate_remove_group,
  validate_update_group,
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

  // 4. Build Output (must have Ref Token + Correct Addr)
  let output_value = assets.from_asset(policy_id, ref_tn, 1)
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

  !validate_create_group(policy_id, 0, 0, [input], [output], mint)
}

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

  !validate_create_group(policy_id, 0, 0, [input], [output], invalid_mint)
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
      assets.from_asset(policy_id, ref_tn, 1),
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
      assets.from_asset(policy_id, ref_tn, 1),
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

  let output_value = assets.from_asset(policy_id, ref_tn, 1)
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
    datum.contribution_fee <= 0 || datum.joining_fee < 0 || datum.penalty_fee < 0 || datum.interval_length <= 0 || datum.num_intervals <= 0 || datum.num_intervals > 100 || datum.member_count != 0 || !datum.is_active

  // The Property:
  // If the datum is invalid, validation MUST return False.
  // If the datum happens to be valid (rare but possible), we expect True.
  if is_invalid {
    !validate_create_group(policy_id, 0, 0, [input], [output, user_output], mint)
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
    GroupDatum {
      ..base_datum,
      contribution_fee_policyid: alt_policy_id,
    }
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

// --- Non-critical: share_holding can change while members are active ---

test update__allows_share_holding_change_with_members() {
  let policy_id = common.test_policy_id()
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)

  // Group has active members — critical fields are frozen, but share_holding is not
  let base_datum =
    GroupDatum { ..common.test_group_datum(policy_id), member_count: 5 }
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

  // Toggle share_holding — non-critical field, allowed with members present
  let updated_datum = GroupDatum { ..base_datum, share_holding: True }
  let group_output =
    common.test_script_utxo(
      policy_id,
      assets.from_asset(policy_id, ref_tn, 1),
      updated_datum,
    )

  validate_update_group(
    policy_id,
    ref_tn,
    1,
    0,
    0,
    [group_input, admin_input],
    [group_output],
  )
}

// --- Property: update rejects critical field change when members are active ---

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

  // Any change to contribution_fee is a critical update — blocked with members
  let updated_datum =
    GroupDatum { ..base_datum, contribution_fee: new_fee + 1 }
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
