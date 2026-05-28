use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value, ada_policy_id}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use dcu/cip68
use dcu/utils.{get_lower_bound}

/// Group Validator Datum
pub type GroupDatum {
  // Human-readable UTF-8 name for this group, stored as raw bytes.
  // Enforced non-empty at creation; frozen once any member has joined.
  group_name: ByteArray,
  contribution_fee_policyid: PolicyId,
  contribution_fee_assetname: AssetName,
  contribution_fee: Int,
  joining_fee_policyid: PolicyId,
  joining_fee_assetname: AssetName,
  joining_fee: Int,
  penalty_fee_policyid: PolicyId,
  penalty_fee_assetname: AssetName,
  penalty_fee: Int,
  // Minimum window before a defaulting member is moved to InsufficientCollateralState.
  // 0 = immediate enforcement. Recommend >= interval_length to give members time to top up.
  grace_period_length: Int,
  // ADA locked in the group UTxO at creation time. Signals admin commitment and
  // deters spam group creation. Returned to admin when deleteGroup burns the tokens.
  // 0 for trusted/family groups; recommend >= contribution_fee for open groups.
  creator_bond: Int,
  interval_length: Int,
  // Set to 0 at creation; assigned to member_count at startGroup.
  // Frozen after startGroup — num_rounds == member_count for the cycle lifetime.
  num_rounds: Int,
  max_members: Int,
  member_count: Int,
  is_active: Bool,
  // False at creation; True after startGroup seals membership.
  // Once True, no new members can join and num_rounds / start_time are fixed.
  is_started: Bool,
  // POSIX millisecond timestamp when the ROSCA rotation schedule begins.
  // 0 until startGroup sets it. Required by treasury for slot calculation:
  //   current_slot = (now - start_time) / interval_length % num_rounds
  start_time: Int,
  // Index of the last completed distribution round. -1 until Distribute runs.
  // Incremented atomically with each Distribute to enforce sequential processing.
  last_distributed_round: Int,
  // 28-byte payment key hash of the group creator's wallet.
  // Joining fees are paid directly to this credential at join time.
  // Frozen as a critical field once any member has joined.
  creator_payment_credential: ByteArray,
  // On-chain membership registry: one entry per active member, set to their treasury
  // token name (prefix_222 + account_suffix). Appended at Join, removed at
  // Exit. Invariant: list.length(member_token_names) == member_count.
  member_token_names: List<AssetName>,
}

/// Group Validator Mint Redeemer
pub type GroupMintRedeemer {
  CreateGroup { input_index: Int, output_index: Int }
  // Burn redeemer: authorises token destruction during deleteGroup.
  // The spend handler (CloseGroup) performs all real validation — member_count == 0,
  // creator auth, exact burn count. This case only verifies no new tokens are minted.
  BurnGroup
}

/// Group Validator Spend Redeemer
pub type GroupSpendRedeemer {
  UpdateGroup {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
    group_output_index: Int,
  }
  CloseGroup {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
  }
  Join {
    group_ref_token_name: AssetName,
    member_token_name: AssetName,
    group_input_index: Int,
    group_output_index: Int,
  }
  Exit {
    group_ref_token_name: AssetName,
    member_token_name: AssetName,
    group_input_index: Int,
    group_output_index: Int,
  }
  // Seals membership and fixes num_rounds = member_count, start_time = tx lower bound.
  // After this, no new members can join and rounds can be distributed.
  StartGroup {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
    group_output_index: Int,
  }
  // Increments last_distributed_round atomically with the treasury distribution.
  // Enforces sequential round processing via round_number == last_distributed_round + 1.
  Distribute {
    group_ref_token_name: AssetName,
    group_input_index: Int,
    group_output_index: Int,
    round_number: Int,
  }
  // Resets the group for another rotation cycle after all rounds are distributed.
  // Members remain in the group; their treasury UTxOs are reset by the treasury
  // validator's NextCycle handler. Members must re-deposit via Contribute before
  // creator calls StartGroup again.
  NextCycle {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
    group_output_index: Int,
  }
}

// validate_create_group
// ─────────────────────────────────────────────────────────────────────────────
// [spec CreateGroup 1]: output at output_index is at the Group Script address
// [spec CreateGroup 2]: exactly two tokens minted — ref_tn qty 1, user_tn qty 1
// [spec CreateGroup 3]: input at input_index consumed to derive unique CIP-68 names
// [spec CreateGroup 4]: contribution_fee > 0
// [spec CreateGroup 5]: joining_fee >= 0
// [spec CreateGroup 6]: penalty_fee >= 0
// [spec CreateGroup 7]: creator_bond >= 0 (0 = no bond; >= contribution_fee recommended)
// [spec CreateGroup 7b]: grace_period_length >= 0
// [spec CreateGroup 8]: interval_length > 0
// [spec CreateGroup 9]: num_rounds == 0 at creation (assigned to member_count at startGroup)
// [spec CreateGroup 10]: member_count == 0 at creation
// [spec CreateGroup 10b]: is_started == False at creation (sealed by startGroup)
// [spec CreateGroup 10c]: last_distributed_round == -1 at creation (no rounds yet)
// [spec CreateGroup 10d]: start_time == 0 at creation (set by startGroup)
// [spec CreateGroup 11]: is_active == True at creation
// [spec CreateGroup 12]: user (222) token must go to a VerificationKey address —
//                        if sent to a script, admin authority is permanently lost
// [spec CreateGroup 13]: creator_payment_credential must be exactly 28 bytes —
//                        enforces a valid payment key hash
// [spec CreateGroup 14]: group_name must be non-empty — prevents anonymous groups
pub fn validate_create_group(
  policy_id: PolicyId,
  input_index: Int,
  output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  expect Some(output) = list.at(outputs, output_index)
  expect InlineDatum(d) = output.datum
  expect datum: GroupDatum = d

  expect Some(params_input) = list.at(inputs, input_index)

  let ref_token_name =
    cip68.unique_token_name(params_input.output_reference, cip68.prefix_100)
  let user_token_name =
    cip68.unique_token_name(params_input.output_reference, cip68.prefix_222)

  let minted_tokens = assets.tokens(mint, policy_id)
  expect Some(1) = dict.get(minted_tokens, ref_token_name)
  expect Some(1) = dict.get(minted_tokens, user_token_name)
  let exact_mint_quantity = dict.size(minted_tokens) == 2

  expect Some(user_output) =
    list.find(
      outputs,
      fn(o) { assets.quantity_of(o.value, policy_id, user_token_name) == 1 },
    )
  let user_token_to_wallet =
    when user_output.address.payment_credential is {
      VerificationKey(_) -> True
      Script(_) -> False
    }

  let output_at_script_address =
    output.address.payment_credential == Script(policy_id)

  let output_has_ref_token =
    assets.quantity_of(output.value, policy_id, ref_token_name) == 1

  // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
  let output_clean_value =
    assets.policies(output.value) == [ada_policy_id, policy_id]

  and {
    exact_mint_quantity?,
    output_at_script_address?,
    output_has_ref_token?,
    output_clean_value?,
    user_token_to_wallet?,
    (datum.contribution_fee > 0)?,
    (datum.joining_fee >= 0)?,
    (datum.penalty_fee >= 0)?,
    // [spec CreateGroup 7]: creator_bond >= 0; 0 is valid for trusted groups
    (datum.creator_bond >= 0)?,
    // [spec CreateGroup 7b]: grace_period_length >= 0; 0 = immediate enforcement
    (datum.grace_period_length >= 0)?,
    (datum.interval_length > 0)?,
    // [spec CreateGroup 9]: num_rounds must be 0 at creation — set at startGroup
    (datum.num_rounds == 0)?,
    // [spec CreateGroup 11a]: max_members must be > 0
    (datum.max_members > 0)?,
    (datum.member_count == 0)?,
    (datum.member_token_names == [])?,
    datum.is_active?,
    // [spec CreateGroup 10b]: group not yet started; sealed by StartGroup
    (!datum.is_started)?,
    // [spec CreateGroup 10d]: start_time set by StartGroup, not creation
    (datum.start_time == 0)?,
    // [spec CreateGroup 10c]: no rounds have run yet
    (datum.last_distributed_round == -1)?,
    // [spec CreateGroup 12]: creator_payment_credential must be a valid 28-byte PKH
    (bytearray.length(datum.creator_payment_credential) == 28)?,
    // [spec CreateGroup 14]: group_name must be non-empty
    (bytearray.length(datum.group_name) > 0)?,
  }
}

// validate_update_group
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check (group_input_index resolves to the UTxO being spent)
//       is enforced at the entry point in group-validator.ak before this function
//       is called — matching the payment-subscription pattern.
//
// [spec UpdateGroup 1]: group input at group_input_index holds the ref token
// [spec UpdateGroup 2]: admin input at admin_input_index holds the user (222) token
// [security        3]: critical fields (fee amounts + policy IDs + asset names +
//                      intervals + creator_bond + grace_period_length) are only
//                      changeable when member_count == 0; changing fee currency is
//                      as disruptive as changing the amount
// [spec UpdateGroup 4]: group output is at the same script address with ref token
// [spec UpdateGroup 5]: member_count is unchanged (managed by treasury join/exit)
// [spec UpdateGroup 5b]: num_rounds, is_started, last_distributed_round are always
//                        frozen in UpdateGroup — managed by StartGroup / DistributeRound
// [spec UpdateGroup 6]: is_active may only transition True → False (deactivation);
//                       reactivation (False → True) is permanently forbidden
// [security        7]: ADA must not decrease from input to output
pub fn validate_update_group(
  policy_id: PolicyId,
  group_ref_token_name: AssetName,
  admin_input_index: Int,
  group_input_index: Int,
  group_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
) -> Bool {
  // 1. Find Group Input
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  // 2. Validate Admin Authorization
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let user_token_name =
    cip68.prefix_222
      |> bytearray.concat(
          bytearray.drop(group_ref_token_name, cip68.prefix_length),
        )
  expect
    assets.quantity_of(admin_input.output.value, policy_id, user_token_name) == 1

  // 3. Validate Group Output
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(datum_data) = group_output.datum
  expect updated_datum: GroupDatum = datum_data

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current_datum: GroupDatum = input_datum_data

  // [security 3]: critical fields include amounts AND policy IDs AND asset names AND
  // schedule parameters. Switching fee currency is an economic rug-pull; changing
  // start_time shifts every member's payout window; reducing max_members can invalidate
  // joins. creator_bond and grace_period_length affect member economics. All must be
  // frozen while any member is active.
  let is_critical_update =
    updated_datum.group_name != current_datum.group_name || updated_datum.contribution_fee != current_datum.contribution_fee || updated_datum.contribution_fee_policyid != current_datum.contribution_fee_policyid || updated_datum.contribution_fee_assetname != current_datum.contribution_fee_assetname || updated_datum.joining_fee != current_datum.joining_fee || updated_datum.joining_fee_policyid != current_datum.joining_fee_policyid || updated_datum.joining_fee_assetname != current_datum.joining_fee_assetname || updated_datum.penalty_fee != current_datum.penalty_fee || updated_datum.penalty_fee_policyid != current_datum.penalty_fee_policyid || updated_datum.penalty_fee_assetname != current_datum.penalty_fee_assetname || updated_datum.creator_bond != current_datum.creator_bond || updated_datum.grace_period_length != current_datum.grace_period_length || updated_datum.interval_length != current_datum.interval_length || updated_datum.creator_payment_credential != current_datum.creator_payment_credential || updated_datum.start_time != current_datum.start_time || updated_datum.max_members != current_datum.max_members

  let is_safe_update = !is_critical_update || current_datum.member_count == 0

  // [security 7]: ADA preservation — admin must not drain the group UTxO during update
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
  let output_clean_value =
    assets.policies(group_output.value) == [ada_policy_id, policy_id]

  and {
    (group_output.address == group_input.output.address)?,
    // [security]: exact token check — only the ref token under this policy
    (dict.to_pairs(assets.tokens(group_output.value, policy_id)) == [
      Pair(group_ref_token_name, 1),
    ])?,
    output_clean_value?,
    is_safe_update?,
    (updated_datum.member_count == current_datum.member_count)?,
    // [spec UpdateGroup 5b]: num_rounds managed by StartGroup — frozen in UpdateGroup
    (updated_datum.num_rounds == current_datum.num_rounds)?,
    // [spec UpdateGroup 5b]: is_started is a one-way latch — only StartGroup sets it True
    (updated_datum.is_started == current_datum.is_started)?,
    // [spec UpdateGroup 5b]: last_distributed_round managed by DistributeRound — frozen here
    (updated_datum.last_distributed_round == current_datum.last_distributed_round)?,
    // [security]: member registry managed exclusively by MemberJoin/MemberExit
    (updated_datum.member_token_names == current_datum.member_token_names)?,
    // [spec UpdateGroup 6]: is_active is a one-way latch — only True → False allowed
    (current_datum.is_active || !updated_datum.is_active)?,
    (out_ada >= in_ada)?,
  }
}

// validate_close_group
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check enforced at entry point.
//
// Burns both group tokens (ref + user) and returns all ADA (including creator_bond)
// to the admin as transaction change. No group UTxO is produced — the group is gone.
//
// [spec CloseGroup 1]: group input at group_input_index holds the ref token
// [spec CloseGroup 2]: admin input at admin_input_index holds the user (222) token
// [spec CloseGroup 3]: is_active == False — group must be deactivated before deletion
// [spec CloseGroup 4]: member_count == 0 — all members must have exited first
// [spec CloseGroup 5]: ref token burned (qty -1 under this policy)
// [spec CloseGroup 6]: user token burned (qty -1 under this policy)
// [spec CloseGroup 7]: exactly these two tokens burned — no others under this policy
pub fn validate_close_group(
  policy_id: PolicyId,
  group_ref_token_name: AssetName,
  admin_input_index: Int,
  group_input_index: Int,
  inputs: List<Input>,
  mint: Value,
) -> Bool {
  // 1. Find Group Input
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current_datum: GroupDatum = input_datum_data

  // 2. Validate Admin Authorization
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let user_token_name =
    cip68.prefix_222
      |> bytearray.concat(
          bytearray.drop(group_ref_token_name, cip68.prefix_length),
        )
  let admin_authorized =
    assets.quantity_of(admin_input.output.value, policy_id, user_token_name) == 1

  // [spec CloseGroup 3]: group must be deactivated before it can be dissolved
  let is_deactivated = !current_datum.is_active
  // [spec CloseGroup 4]: all members must have exited
  let no_members = current_datum.member_count == 0

  // [spec CloseGroup 4-6]: both tokens burned, no others under this policy
  let burned_tokens = assets.tokens(mint, policy_id)
  let ref_burned = dict.get(burned_tokens, group_ref_token_name) == Some(-1)
  let user_burned = dict.get(burned_tokens, user_token_name) == Some(-1)
  // [security]: exactly two burns — prevents partial-burn attack leaving a ghost token
  let exact_burn = dict.size(burned_tokens) == 2

  and {
    admin_authorized?,
    is_deactivated?,
    no_members?,
    ref_burned?,
    user_burned?,
    exact_burn?,
  }
}

// validate_member_join
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check enforced at entry point.
//
// [spec Join 0]: group must NOT be started — no late joins after startGroup
// [spec Join 1]: group input holds the ref token
// [spec Join 2]: treasury is minting exactly 1 token under treasury_policy_id —
//                      proves JoinGroup ran in the same tx
// [spec Join 3]: group output is at the same script address with ref token
// [spec Join 4]: only member_count changes — increments by exactly 1;
//                      all other fields are structurally identical to the input datum
pub fn validate_join(
  policy_id: PolicyId,
  treasury_policy_id: PolicyId,
  group_ref_token_name: AssetName,
  member_token_name: AssetName,
  group_input_index: Int,
  group_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  // [spec Join 1]: group input holds the ref token
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current: GroupDatum = input_datum_data

  // [spec Join 0]: group must not be started — StartGroup seals membership
  let not_started = !current.is_started

  // [spec Join 3]: group output at script address with ref token
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated: GroupDatum = output_datum_data

  // [spec Join 2]: treasury mints exactly 1 token under treasury policy
  let minted_treasury_tokens = assets.tokens(mint, treasury_policy_id)
  let treasury_minting =
    dict.get(minted_treasury_tokens, member_token_name) == Some(1) && dict.size(
      minted_treasury_tokens,
    ) == 1

  // [security MemberJoin]: prevent double-join
  let member_not_duplicate =
    !list.any(current.member_token_names, fn(n) { n == member_token_name })

  // [spec Join 4]: only member_count increments and member_token_names appended;
  // all other fields unchanged
  let expected =
    GroupDatum {
      ..current,
      member_count: current.member_count + 1,
      member_token_names: [member_token_name, ..current.member_token_names],
    }

  // [security]: ADA must not decrease
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy
  let output_clean_value =
    assets.policies(group_output.value) == [ada_policy_id, policy_id]

  and {
    not_started?,
    treasury_minting?,
    member_not_duplicate?,
    (group_output.address == group_input.output.address)?,
    (assets.quantity_of(group_output.value, policy_id, group_ref_token_name) == 1)?,
    output_clean_value?,
    (updated == expected)?,
    (out_ada >= in_ada)?,
  }
}

// validate_member_exit
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check enforced at entry point.
//
// Covers all exit scenarios — member_count ALWAYS decrements:
//   1. Mature/inactive ExitGroup (burn path): token burned, slot freed immediately
//   2. Early ExitGroup (penalty path): token moves to PenaltyState, slot freed immediately
//
// [spec Exit 1]: group input holds the ref token
// [spec Exit 2]: member_count always decrements by exactly 1
// [spec Exit 3]: member_count >= 1 before exit
// [spec Exit 4]: group output at same script address with ref token
// [spec Exit 5]: only member_count may change; all other fields frozen
// [security MemberExit 6]: treasury validator must participate (burn or spend)
pub fn validate_exit(
  policy_id: PolicyId,
  treasury_policy_id: PolicyId,
  group_ref_token_name: AssetName,
  member_token_name: AssetName,
  group_input_index: Int,
  group_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  _mint: Value,
) -> Bool {
  // [spec Exit 1]: group input holds the ref token
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current: GroupDatum = input_datum_data

  // [spec Exit 3]: member_count must be >= 1 before decrement
  expect current.member_count >= 1

  // [spec Exit 4]: group output at script address with ref token
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated: GroupDatum = output_datum_data

  // [spec Exit 2 & 5]: member_count decrements by 1; member removed from registry;
  // all other fields frozen
  let expected =
    GroupDatum {
      ..current,
      member_count: current.member_count - 1,
      member_token_names: list.filter(
        current.member_token_names,
        fn(n) { n != member_token_name },
      ),
    }

  // [security]: ADA must not decrease
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy
  let output_clean_value =
    assets.policies(group_output.value) == [ada_policy_id, policy_id]

  // [security MemberExit 6]: authenticate member_token_name via treasury spending input
  let member_token_authenticated =
    list.any(
      inputs,
      fn(i) {
        assets.quantity_of(
          i.output.value,
          treasury_policy_id,
          member_token_name,
        ) == 1
      },
    )

  // [security MemberExit]: member must exist in current registry
  let member_exists =
    list.any(current.member_token_names, fn(n) { n == member_token_name })

  and {
    member_token_authenticated?,
    member_exists?,
    (group_output.address == group_input.output.address)?,
    (assets.quantity_of(group_output.value, policy_id, group_ref_token_name) == 1)?,
    output_clean_value?,
    (updated == expected)?,
    (out_ada >= in_ada)?,
  }
}

// validate_start_group
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check enforced at entry point.
//
// Seals membership and fixes the rotation schedule. After this, no new members
// can join and DistributeRound becomes available.
//
// [spec StartGroup 1]: group input holds the ref token
// [spec StartGroup 2]: admin input holds the user (222) token
// [spec StartGroup 3]: group must not already be started (!is_started)
// [spec StartGroup 4]: member_count >= 2 — at minimum a two-member ROSCA is required
// [spec StartGroup 5]: group output: is_started = True, num_rounds = member_count,
//                      start_time = tx lower bound, all other fields frozen
// [security StartGroup]: ADA must not decrease; output has only ADA + own policy
pub fn validate_start_group(
  policy_id: PolicyId,
  group_ref_token_name: AssetName,
  admin_input_index: Int,
  group_input_index: Int,
  group_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  tx: Transaction,
) -> Bool {
  // [spec StartGroup 1]: group input holds the ref token
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current: GroupDatum = input_datum_data

  // [spec StartGroup 2]: admin holds the user (222) token
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let user_token_name =
    cip68.prefix_222
      |> bytearray.concat(
          bytearray.drop(group_ref_token_name, cip68.prefix_length),
        )
  let admin_authorized =
    assets.quantity_of(admin_input.output.value, policy_id, user_token_name) == 1

  // [spec StartGroup 3]: group must not already be started
  let not_already_started = !current.is_started

  // [spec StartGroup 4]: at least 2 members required for a ROSCA
  let enough_members = current.member_count >= 2

  // [spec StartGroup 5]: group output fields
  let current_time = get_lower_bound(tx)
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated: GroupDatum = output_datum_data

  let expected =
    GroupDatum {
      ..current,
      is_started: True,
      num_rounds: current.member_count,
      start_time: current_time,
    }

  // [security]: ADA must not decrease
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy
  let output_clean_value =
    assets.policies(group_output.value) == [ada_policy_id, policy_id]

  and {
    admin_authorized?,
    not_already_started?,
    enough_members?,
    (group_output.address == group_input.output.address)?,
    (dict.to_pairs(assets.tokens(group_output.value, policy_id)) == [
      Pair(group_ref_token_name, 1),
    ])?,
    output_clean_value?,
    (updated == expected)?,
    (out_ada >= in_ada)?,
  }
}

// validate_distribute_round_group
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check enforced at entry point.
//
// Updates last_distributed_round on the group UTxO atomically with the treasury
// distribution. Enforces that rounds run sequentially and within the cycle.
//
// [spec DistributeRound 1]: group input holds the ref token
// [spec DistributeRound 2]: group must be started and active
// [spec DistributeRound 3]: round_number == last_distributed_round + 1 (sequential)
// [spec DistributeRound 4]: current_time >= start_time + round_number * interval_length
// [spec DistributeRound 5]: round_number < num_rounds (within cycle)
// [spec DistributeRound 6]: group output: last_distributed_round = round_number;
//                           all other fields frozen
// [security]: ADA must not decrease; output has only ADA + own policy
pub fn validate_distribute_group(
  policy_id: PolicyId,
  group_ref_token_name: AssetName,
  group_input_index: Int,
  group_output_index: Int,
  round_number: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  tx: Transaction,
) -> Bool {
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current: GroupDatum = input_datum_data

  // [spec DistributeRound 2]: group must be started and active
  let group_started = current.is_started
  let group_active = current.is_active

  // [spec DistributeRound 3]: sequential round enforcement
  let sequential = round_number == current.last_distributed_round + 1

  // [spec DistributeRound 4]: time gate — round can't run before its scheduled start
  let current_time = get_lower_bound(tx)
  let round_start_time =
    current.start_time + round_number * current.interval_length
  let time_valid = current_time >= round_start_time

  // [spec DistributeRound 5]: round must be within the current cycle
  let within_cycle = round_number >= 0 && round_number < current.num_rounds

  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated: GroupDatum = output_datum_data

  // [spec DistributeRound 6]: only last_distributed_round changes
  let expected = GroupDatum { ..current, last_distributed_round: round_number }

  // [security]: ADA must not decrease
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy
  let output_clean_value =
    assets.policies(group_output.value) == [ada_policy_id, policy_id]

  and {
    group_started?,
    group_active?,
    sequential?,
    time_valid?,
    within_cycle?,
    (group_output.address == group_input.output.address)?,
    (dict.to_pairs(assets.tokens(group_output.value, policy_id)) == [
      Pair(group_ref_token_name, 1),
    ])?,
    output_clean_value?,
    (updated == expected)?,
    (out_ada >= in_ada)?,
  }
}

// validate_next_cycle_group
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check enforced at entry point.
//
// Resets the group for another rotation cycle after all rounds are distributed.
// Members remain in the group and re-deposit via Contribute before the admin
// calls StartGroup again.
//
// [spec NextCycle 1]: group input holds the ref token
// [spec NextCycle 2]: admin input holds the user (222) token
// [spec NextCycle 3]: group must be started and active
// [spec NextCycle 4]: all rounds complete: last_distributed_round + 1 == num_rounds
// [spec NextCycle 5]: group output: is_started=False, last_distributed_round=-1,
//                     num_rounds=0, start_time=0; all other fields frozen
// [security NextCycle]: ADA must not decrease; output holds only ADA + own policy
pub fn validate_next_cycle_group(
  policy_id: PolicyId,
  group_ref_token_name: AssetName,
  admin_input_index: Int,
  group_input_index: Int,
  group_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
) -> Bool {
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1

  expect InlineDatum(input_datum_data) = group_input.output.datum
  expect current: GroupDatum = input_datum_data

  let user_token_name =
    cip68.prefix_222
      |> bytearray.concat(
          bytearray.drop(group_ref_token_name, cip68.prefix_length),
        )
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let admin_authorized =
    assets.quantity_of(admin_input.output.value, policy_id, user_token_name) == 1

  // [spec NextCycle 3]: group must be started and active
  let group_started = current.is_started
  let group_active = current.is_active

  // [spec NextCycle 4]: all rounds have been distributed
  let all_rounds_done =
    current.last_distributed_round + 1 == current.num_rounds

  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated: GroupDatum = output_datum_data

  // [spec NextCycle 5]: reset cycle fields; all other fields frozen
  let expected =
    GroupDatum {
      ..current,
      is_started: False,
      last_distributed_round: -1,
      num_rounds: 0,
      start_time: 0,
    }

  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  let output_clean_value =
    assets.policies(group_output.value) == [ada_policy_id, policy_id]

  and {
    admin_authorized?,
    group_started?,
    group_active?,
    all_rounds_done?,
    (group_output.address == group_input.output.address)?,
    (dict.to_pairs(assets.tokens(group_output.value, policy_id)) == [
      Pair(group_ref_token_name, 1),
    ])?,
    output_clean_value?,
    (updated == expected)?,
    (out_ada >= in_ada)?,
  }
}
