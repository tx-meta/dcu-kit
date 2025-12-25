use aiken/primitive/bytearray
use cardano/address
use cardano/assets
use dcu/cip68
use dcu/group.{GroupDatum} as group_lib
use tests/common

test create_group_success() {
  let policy_id = #"00000000000000000000000000000000000000000000000000000000"
  
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
  let output = common.test_output(address.from_script(policy_id), output_value, datum)

  // 5. Build Input
  let input = common.test_input(output_ref, output)

  let inputs = [input]
  let outputs = [output]

  // Expectation: returns True
  group_lib.validate_create_group(policy_id, 0, 0, inputs, outputs, mint)
}

test create_group_invalid_fee() {
  let policy_id = #"00000000000000000000000000000000000000000000000000000000"
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  
  let mint = 
      assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let base_datum = common.test_group_datum(policy_id)
  let datum = GroupDatum { ..base_datum, contribution_fee: 0 }
  
  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_output(address.from_script(policy_id), output_value, datum)
  let input = common.test_input(output_ref, output)

  !group_lib.validate_create_group(policy_id, 0, 0, [input], [output], mint)
}

test create_group_invalid_member_count() {
  let policy_id = #"00000000000000000000000000000000000000000000000000000000"
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  
  let mint = 
      assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let base_datum = common.test_group_datum(policy_id)
  let datum = GroupDatum { ..base_datum, member_count: 1 }

  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_output(address.from_script(policy_id), output_value, datum)
  let input = common.test_input(output_ref, output)

  !group_lib.validate_create_group(policy_id, 0, 0, [input], [output], mint)
}

test create_group_invalid_intervals() {
  let policy_id = #"00000000000000000000000000000000000000000000000000000000"
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  
  let mint = 
      assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let base_datum = common.test_group_datum(policy_id)
  let datum = GroupDatum { ..base_datum, interval_length: 0 }

  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_output(address.from_script(policy_id), output_value, datum)
  let input = common.test_input(output_ref, output)

  !group_lib.validate_create_group(policy_id, 0, 0, [input], [output], mint)
}

test create_group_inactive() {
  let policy_id = #"00000000000000000000000000000000000000000000000000000000"
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  
  let mint = 
      assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let base_datum = common.test_group_datum(policy_id)
  let datum = GroupDatum { ..base_datum, is_active: False }

  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_output(address.from_script(policy_id), output_value, datum)
  let input = common.test_input(output_ref, output)

  !group_lib.validate_create_group(policy_id, 0, 0, [input], [output], mint)
}

test create_group_wrong_token_names() fail {
  let policy_id = #"00000000000000000000000000000000000000000000000000000000"
  let (output_ref, ref_tn, _user_tn) = common.setup_cip68(policy_id)
  let datum = common.test_group_datum(policy_id)
  
  // Use a WRONG suffix to simulate mismatch
  let wrong_suffix = #"badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad" 
  let wrong_ref_tn = cip68.prefix_100 |> bytearray.concat(wrong_suffix)
  let wrong_user_tn = cip68.prefix_222 |> bytearray.concat(wrong_suffix)
  
  let mint = 
      assets.from_asset(policy_id, wrong_ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, wrong_user_tn, 1))
  
  // Even if we put the 'correct' ref token in output (unlikely scenario but possible if mismatched),
  // validation should fail on mint check first.
  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_output(address.from_script(policy_id), output_value, datum)
  let input = common.test_input(output_ref, output)

  !group_lib.validate_create_group(policy_id, 0, 0, [input], [output], mint)
}

test create_group_wrong_mint_quantity() fail {
  let policy_id = #"00000000000000000000000000000000000000000000000000000000"
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let datum = common.test_group_datum(policy_id)

  // Invalid: Minting 2 Reference Tokens instead of 1
  let invalid_mint = 
      assets.from_asset(policy_id, ref_tn, 2)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))
  
  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  let output = common.test_output(address.from_script(policy_id), output_value, datum)
  let input = common.test_input(output_ref, output)

  !group_lib.validate_create_group(policy_id, 0, 0, [input], [output], invalid_mint)
}

test create_group_wrong_output_address_fails() {
  let policy_id = #"00000000000000000000000000000000000000000000000000000000"
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let datum = common.test_group_datum(policy_id)
  
  let mint = 
      assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  let output_value = assets.from_asset(policy_id, ref_tn, 1)
  
  // FAILURE CASE: Wrong Address (not script address)
  let wrong_addr = address.from_verification_key(#"bad00000000000000000000000000000000000000000000000000000")
  let output = common.test_output(wrong_addr, output_value, datum)
  
  let input = common.test_input(output_ref, output)

  !group_lib.validate_create_group(policy_id, 0, 0, [input], [output], mint)
}

test create_group_missing_ref_token_fails() {
  let policy_id = #"00000000000000000000000000000000000000000000000000000000"
  let (output_ref, ref_tn, user_tn) = common.setup_cip68(policy_id)
  let datum = common.test_group_datum(policy_id)
  
  let mint = 
      assets.from_asset(policy_id, ref_tn, 1)
      |> assets.merge(assets.from_asset(policy_id, user_tn, 1))

  // FAILURE CASE: Output has NO value (missing ref token)
  let output_value = assets.zero
  let output = common.test_output(address.from_script(policy_id), output_value, datum)
  
  let input = common.test_input(output_ref, output)

  !group_lib.validate_create_group(policy_id, 0, 0, [input], [output], mint)
}

