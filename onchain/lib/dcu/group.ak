use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use dcu/cip68
use dcu/utils.{get_lower_bound, output_holds_only_own}

/// Protocol-wide ceiling on members per group, enforced at create-group (a group cannot
/// declare a larger max_members) and at join (member_count can never reach it).
///
/// Bound by the distribute / next-cycle transaction budget: after the withdraw-zero change
/// the heavy round logic runs once in the treasury `withdraw` handler, but `count_active_members`
/// is still O(N²), so per-tx mem grows ~quadratically. Measured `count_active` mem (real UPLC):
/// N=20 ≈ 6.77M of the 14M per-tx limit, leaving headroom for the per-input fold; N=30 ≈ 13.73M
/// (unsafe). 20 is a CONSERVATIVE starting cap covering typical chamas (5–30 real-world).
/// FINALISE on Preprod: run distribute at increasing sizes and read the treasury REWARD
/// (withdraw) redeemer's Mem/CPU via `pnpm run inspect-tx` (sdk/examples/inspect-tx.ts);
/// raise/lower this constant to sit safely below the crossover. See [[scale-ceiling-findings]].
pub const max_group_members: Int = 20

/// CIP-68 wrapper for the group (100) reference token datum.
/// Wallets resolve the group name by reading metadata["name"] from this datum.
/// `extra` holds all protocol state; metadata and version are preserved unchanged
/// through every state transition except UpdateGroup (which may update them when
/// member_count == 0).
pub type GroupCip68Datum {
  // UTF-8 text key → UTF-8 text value display metadata. Must contain key
  // #"6e616d65" ("name") with a non-empty value. Serialises as a raw Plutus map —
  // Pairs<ByteArray, ByteArray>, NOT Dict (Dict adds a Constr wrapper that breaks
  // CIP-68 wallet resolution).
  metadata: Pairs<ByteArray, ByteArray>,
  // 1 for all groups created by this protocol version.
  version: Int,
  // All ROSCA protocol state. Validated by all group/treasury redeemers.
  extra: GroupDatum,
}

/// Payout delivery mode, fixed at group creation and frozen once members join.
///   Push = current behaviour: DistributeRound builds a wallet output paying the
///          borrower the pro-rata pot directly. Backwards compatible default.
///   Pull  = DistributeRound earmarks the pot into the borrower's OWN treasury UTxO
///          (TreasuryState.claimable_balance); the borrower later withdraws it to any
///          address via ClaimPayout (gated by possession of the member 222 token).
///          Solves the lost-wallet problem; entitlement is durable until claimed or exit.
pub type PayoutMode {
  Push
  Pull
}

/// Group Validator Datum — protocol state only, no display metadata.
pub type GroupDatum {
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
  // Cached count of members currently in TreasuryState (contributing). Maintained
  // incrementally: +1 at Join and at Contribute-recovery, -1 at Exit and per ICS
  // transition inside DistributeRound. Distribute reads it in O(1) for the pro-rata pot
  // (replacing the O(N^2) count_active_members fold) and pins the spent-set size to it
  // (C4 anti-skim). MUST be 0 at creation; startGroup sets it to member_count.
  active_member_count: Int,
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
  // Number of rounds' worth of contribution_fee a member must lock at join.
  // 1 = PerRound (traditional ROSCA, default); max_members = FullUpfront (trustless);
  // any k in between = partial. The join floor is contribution_fee * collateral_rounds.
  // Deposits are never capped — distribute deducts exactly contribution_fee per round.
  // Frozen once any member has joined (critical field in validate_update_group).
  collateral_rounds: Int,
  // Payout delivery mode (Push = direct wallet output; Pull = earmark + ClaimPayout).
  // Fixed at creation; frozen once any member has joined (critical field).
  payout_mode: PayoutMode,
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

// cip68_name_key: UTF-8 bytes for the string "name" — the standard CIP-68 display name key.
const cip68_name_key: ByteArray = #"6e616d65"

// ─── Shared Helpers ───────────────────────────────────────────────────────────

// load_group_input: fetch the group input at `index`, verify it holds exactly one
// (100) ref token under this policy, and unwrap its CIP-68 datum. Shared by every
// handler that spends/reads the group UTxO.
fn load_group_input(
  inputs: List<Input>,
  group_input_index: Int,
  policy_id: PolicyId,
  group_ref_token_name: AssetName,
) -> (Input, GroupCip68Datum) {
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect
    assets.quantity_of(
      group_input.output.value,
      policy_id,
      group_ref_token_name,
    ) == 1
  expect InlineDatum(d) = group_input.output.datum
  expect cip68: GroupCip68Datum = d
  (group_input, cip68)
}

// group_admin_authorized: the input at `admin_input_index` holds the group (222)
// user token derived from the ref token name — i.e. the caller is the group admin.
fn group_admin_authorized(
  inputs: List<Input>,
  admin_input_index: Int,
  policy_id: PolicyId,
  group_ref_token_name: AssetName,
) -> Bool {
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let user_token_name = cip68.convert_ref_to_user_token(group_ref_token_name)
  assets.quantity_of(admin_input.output.value, policy_id, user_token_name) == 1
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
// [spec CreateGroup 14]: metadata["name"] must be non-empty — prevents anonymous groups
// [spec CreateGroup 15]: CIP-68 wrapper version == 1
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
  expect GroupCip68Datum { metadata, version, extra: datum } = d

  expect Some(params_input) = list.at(inputs, input_index)

  let ref_token_name = cip68.unique_token_name(
    params_input.output_reference,
    cip68.prefix_100,
  )
  let user_token_name = cip68.unique_token_name(
    params_input.output_reference,
    cip68.prefix_222,
  )

  let minted_tokens = assets.tokens(mint, policy_id)
  expect Some(1) = dict.get(minted_tokens, ref_token_name)
  expect Some(1) = dict.get(minted_tokens, user_token_name)
  let exact_mint_quantity = dict.size(minted_tokens) == 2

  expect Some(user_output) = list.find(
    outputs,
    fn(o) { assets.quantity_of(o.value, policy_id, user_token_name) == 1 },
  )
  let user_token_to_wallet = when user_output.address.payment_credential is {
    VerificationKey(_) -> True
    Script(_) -> False
  }

  let output_at_script_address = output.address.payment_credential == Script(
    policy_id,
  )

  let output_has_ref_token = assets.quantity_of(
    output.value,
    policy_id,
    ref_token_name,
  ) == 1

  // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
  let output_clean_value = output_holds_only_own(output.value, policy_id)

  // [spec CreateGroup 14]: metadata["name"] must be present and non-empty
  let name_valid = when
    list.find(metadata, fn(p) { p.1st == cip68_name_key })
  is {
    Some(Pair(_, name)) -> bytearray.length(name) > 0
    None -> False
  }

  and {
    exact_mint_quantity?,
    output_at_script_address?,
    output_has_ref_token?,
    output_clean_value?,
    user_token_to_wallet?,
    // [spec CreateGroup 15]: version must be 1 at creation
    (version == 1)?,
    name_valid?,
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
    // [spec CreateGroup 11b / scale]: max_members must not exceed the protocol ceiling, so
    // a group can never grow past a submittable distribute/next-cycle tx. See max_group_members.
    (datum.max_members <= max_group_members)?,
    (datum.member_count == 0)?,
    // [spec CreateGroup 10e]: active_member_count == 0 at creation; startGroup sets it to member_count
    (datum.active_member_count == 0)?,
    (datum.member_token_names == [])?,
    datum.is_active?,
    // [spec CreateGroup 10b]: group not yet started; sealed by StartGroup
    (!datum.is_started)?,
    // [spec CreateGroup 10d]: start_time set by StartGroup, not creation
    (datum.start_time == 0)?,
    // [spec CreateGroup 10c]: no rounds have run yet
    (datum.last_distributed_round == -1)?,
    // [spec CreateGroup 13]: creator_payment_credential must be a valid 28-byte PKH
    (bytearray.length(datum.creator_payment_credential) == 28)?,
    // [spec CreateGroup 16]: collateral_rounds in [1, max_members]
    // 1 = PerRound (default), max_members = FullUpfront, k = partial.
    (datum.collateral_rounds >= 1)?,
    (datum.collateral_rounds <= datum.max_members)?,
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
  // 1. Find Group Input + unwrap CIP-68 datum
  let  
      (
        group_input,
        GroupCip68Datum {
          metadata: input_metadata,
          version: input_version,
          extra: current_datum,
        },
      )
    = load_group_input(
    inputs,
    group_input_index,
    policy_id,
    group_ref_token_name,
  )

  // 2. Validate Admin Authorization
  expect
    group_admin_authorized(
      inputs,
      admin_input_index,
      policy_id,
      group_ref_token_name,
    )

  // 3. Validate Group Output — unwrap CIP-68 from output
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(datum_data) = group_output.datum
  expect  
      GroupCip68Datum {
        metadata: output_metadata,
        version: output_version,
        extra: updated_datum,
      }
    = datum_data

  // [security 3]: once any member has joined, the group's economic terms are frozen —
  // switching fee currency is a rug-pull, shifting start_time moves every payout window,
  // reducing max_members invalidates joins, etc. Expressed as an ALLOWLIST (compare the
  // whole record) rather than a denylist of critical fields: the ONLY field an update may
  // change after a join is `is_active` (and only True -> False, enforced below). A
  // GroupDatum field added in future is therefore frozen-by-default and can never silently
  // remain mutable-after-join — the failure mode of the old 20-term `||` enumeration.
  // Equivalent to that enumeration: every field except is_active is covered here, and the
  // structural fields (member_count, num_rounds, is_started, last_distributed_round,
  // member_token_names) are additionally pinned in the `and { .. }` block below.
  // metadata and version (CIP-68 wrapper) are frozen separately as they live off the datum.
  let metadata_frozen =
    output_metadata == input_metadata && output_version == input_version
  let only_is_active_differs =
    updated_datum == GroupDatum { ..current_datum, is_active: updated_datum.is_active }

  let is_safe_update =
    current_datum.member_count == 0 || metadata_frozen && only_is_active_differs

  // [security 7]: ADA preservation — admin must not drain the group UTxO during update
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
  let output_clean_value = output_holds_only_own(group_output.value, policy_id)

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
  // 1. Find Group Input + unwrap CIP-68 datum (ref-token presence checked in helper)
  let (_group_input, GroupCip68Datum { extra: current_datum, .. }) = load_group_input(
    inputs,
    group_input_index,
    policy_id,
    group_ref_token_name,
  )

  // 2. Validate Admin Authorization
  let admin_authorized = group_admin_authorized(
    inputs,
    admin_input_index,
    policy_id,
    group_ref_token_name,
  )

  // [spec CloseGroup 3]: group must be deactivated before it can be dissolved
  let is_deactivated = !current_datum.is_active
  // [spec CloseGroup 4]: all members must have exited
  let no_members = current_datum.member_count == 0

  // [spec CloseGroup 4-6]: both tokens burned, no others under this policy
  let user_token_name = cip68.convert_ref_to_user_token(group_ref_token_name)
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
pub fn validate_join_group(
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
  let (group_input, GroupCip68Datum { metadata, version, extra: current }) = load_group_input(
    inputs,
    group_input_index,
    policy_id,
    group_ref_token_name,
  )

  // [spec Join 0]: group must not be started — StartGroup seals membership
  let not_started = !current.is_started

  // [spec Join 3]: group output at script address with ref token
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated_cip68: GroupCip68Datum = output_datum_data

  // [spec Join 2]: treasury mints exactly 1 token under treasury policy
  let minted_treasury_tokens = assets.tokens(mint, treasury_policy_id)
  let treasury_minting = dict.get(minted_treasury_tokens, member_token_name) == Some(
    1,
  ) && dict.size(minted_treasury_tokens) == 1

  // [security MemberJoin]: prevent double-join
  let member_not_duplicate = !list.any(
    current.member_token_names,
    fn(n) { n == member_token_name },
  )

  // [spec Join 4]: only member_count increments and member_token_names appended;
  // all other fields unchanged; metadata and version preserved
  let expected = GroupCip68Datum {
    metadata,
    version,
    extra: GroupDatum {
      ..current,
      member_count: current.member_count + 1,
      // [spec Join 4b]: a new member joins in TreasuryState → active set grows by 1.
      active_member_count: current.active_member_count + 1,
      member_token_names: [member_token_name, ..current.member_token_names],
    },
  }

  // [security]: ADA must not decrease
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy
  let output_clean_value = output_holds_only_own(group_output.value, policy_id)

  // [spec Join 0b / scale]: the group cannot exceed its own max_members. With the cap also
  // bounded at create-group (max_members <= max_group_members), this keeps every group's
  // distribute / next-cycle tx within the protocol budget.
  let under_cap = current.member_count < current.max_members

  and {
    not_started?,
    under_cap?,
    treasury_minting?,
    member_not_duplicate?,
    (group_output.address == group_input.output.address)?,
    (assets.quantity_of(group_output.value, policy_id, group_ref_token_name) == 1)?,
    output_clean_value?,
    (updated_cip68 == expected)?,
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
pub fn validate_exit_group(
  policy_id: PolicyId,
  treasury_policy_id: PolicyId,
  group_ref_token_name: AssetName,
  member_token_name: AssetName,
  group_input_index: Int,
  group_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
) -> Bool {
  // [spec Exit 1]: group input holds the ref token
  let (group_input, GroupCip68Datum { metadata, version, extra: current }) = load_group_input(
    inputs,
    group_input_index,
    policy_id,
    group_ref_token_name,
  )

  // [spec Exit 3]: member_count must be >= 1 before decrement
  expect current.member_count >= 1

  // [spec Exit 4]: group output at script address with ref token
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated_cip68: GroupCip68Datum = output_datum_data

  // [spec Exit 2 & 5]: member_count decrements by 1; member removed from registry;
  // all other fields frozen; metadata and version preserved
  let expected = GroupCip68Datum {
    metadata,
    version,
    extra: GroupDatum {
      ..current,
      member_count: current.member_count - 1,
      // [spec Exit 5b]: ExitGroup is TreasuryState-only (treasury validator rejects
      // Default/Penalty), so the leaver is always an active member → active set shrinks
      // by 1. Defaulters leave via TerminateDefault, which does NOT touch active_member_count
      // (they were already removed from it at their ICS transition) — no double-count.
      active_member_count: current.active_member_count - 1,
      member_token_names: list.filter(
        current.member_token_names,
        fn(n) { n != member_token_name },
      ),
    },
  }

  // [security]: ADA must not decrease
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy
  let output_clean_value = output_holds_only_own(group_output.value, policy_id)

  // [security MemberExit 6]: authenticate member_token_name via treasury spending input
  let member_token_authenticated = list.any(
    inputs,
    fn(i) {
      assets.quantity_of(i.output.value, treasury_policy_id, member_token_name) == 1
    },
  )

  // [security MemberExit]: member must exist in current registry
  let member_exists = list.any(
    current.member_token_names,
    fn(n) { n == member_token_name },
  )

  and {
    member_token_authenticated?,
    member_exists?,
    (group_output.address == group_input.output.address)?,
    (assets.quantity_of(group_output.value, policy_id, group_ref_token_name) == 1)?,
    output_clean_value?,
    (updated_cip68 == expected)?,
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
  let (group_input, GroupCip68Datum { metadata, version, extra: current }) = load_group_input(
    inputs,
    group_input_index,
    policy_id,
    group_ref_token_name,
  )

  // [spec StartGroup 2]: admin holds the user (222) token
  let admin_authorized = group_admin_authorized(
    inputs,
    admin_input_index,
    policy_id,
    group_ref_token_name,
  )

  // [spec StartGroup 3]: group must not already be started
  let not_already_started = !current.is_started

  // [spec StartGroup 4]: at least 2 members required for a ROSCA
  let enough_members = current.member_count >= 2

  // [spec StartGroup 5]: group output fields
  let current_time = get_lower_bound(tx)
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated_cip68: GroupCip68Datum = output_datum_data

  let expected = GroupCip68Datum {
    metadata,
    version,
    extra: GroupDatum {
      ..current,
      is_started: True,
      num_rounds: current.member_count,
      start_time: current_time,
      // [spec StartGroup 5b]: seal the active set = full membership at start.
      active_member_count: current.member_count,
    },
  }

  // [security]: ADA must not decrease
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy
  let output_clean_value = output_holds_only_own(group_output.value, policy_id)

  and {
    admin_authorized?,
    not_already_started?,
    enough_members?,
    (group_output.address == group_input.output.address)?,
    (dict.to_pairs(assets.tokens(group_output.value, policy_id)) == [
      Pair(group_ref_token_name, 1),
    ])?,
    output_clean_value?,
    (updated_cip68 == expected)?,
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
  let (group_input, GroupCip68Datum { metadata, version, extra: current }) = load_group_input(
    inputs,
    group_input_index,
    policy_id,
    group_ref_token_name,
  )

  // [spec DistributeRound 2]: group must be started and active
  let group_started = current.is_started
  let group_active = current.is_active

  // [spec DistributeRound 3]: sequential round enforcement
  let sequential = round_number == current.last_distributed_round + 1

  // [spec DistributeRound 4]: time gate — round can't run before its scheduled start
  let current_time = get_lower_bound(tx)
  let round_start_time = current.start_time + round_number * current.interval_length
  let time_valid = current_time >= round_start_time

  // [spec DistributeRound 5 / continuous]: round_number is monotonic and UNBOUNDED above —
  // a cycle is just num_rounds rounds and the rotation wraps via effective_slot =
  // round_number % num_rounds (treasury side). There is no per-cycle cap and no NextCycle
  // reset: distribute simply keeps running, so "next cycle" needs no separate trigger.
  let round_number_valid = round_number >= 0

  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated_cip68: GroupCip68Datum = output_datum_data

  // [spec DistributeRound 6 / D3]: last_distributed_round advances to round_number; metadata and
  // version frozen. active_member_count may DECREASE by the round's ICS transitions — the exact
  // new value is pinned by the treasury withdraw handler (= old - ics_count). Here we accept the
  // output's value (so this equality does not freeze it) and bound it to [0, current] so a
  // group-only spend can never INFLATE the active set (which would over-pay future borrowers).
  let new_active = updated_cip68.extra.active_member_count
  let active_count_bounded = new_active >= 0 && new_active <= current.active_member_count
  let expected = GroupCip68Datum {
    metadata,
    version,
    extra: GroupDatum {
      ..current,
      last_distributed_round: round_number,
      active_member_count: new_active,
    },
  }

  // [security]: ADA must not decrease
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy
  let output_clean_value = output_holds_only_own(group_output.value, policy_id)

  and {
    group_started?,
    group_active?,
    sequential?,
    time_valid?,
    round_number_valid?,
    active_count_bounded?,
    (group_output.address == group_input.output.address)?,
    (dict.to_pairs(assets.tokens(group_output.value, policy_id)) == [
      Pair(group_ref_token_name, 1),
    ])?,
    output_clean_value?,
    (updated_cip68 == expected)?,
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
  let (group_input, GroupCip68Datum { metadata, version, extra: current }) = load_group_input(
    inputs,
    group_input_index,
    policy_id,
    group_ref_token_name,
  )

  let user_token_name = cip68.convert_ref_to_user_token(group_ref_token_name)
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let admin_authorized = assets.quantity_of(
    admin_input.output.value,
    policy_id,
    user_token_name,
  ) == 1

  // [spec NextCycle 3]: group must be started and active
  let group_started = current.is_started
  let group_active = current.is_active

  // [spec NextCycle 4]: all rounds have been distributed
  let all_rounds_done = current.last_distributed_round + 1 == current.num_rounds

  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated_cip68: GroupCip68Datum = output_datum_data

  // [spec NextCycle 5]: reset cycle fields; metadata and version preserved
  let expected = GroupCip68Datum {
    metadata,
    version,
    extra: GroupDatum {
      ..current,
      is_started: False,
      last_distributed_round: -1,
      num_rounds: 0,
      start_time: 0,
    },
  }

  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  let output_clean_value = output_holds_only_own(group_output.value, policy_id)

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
    (updated_cip68 == expected)?,
    (out_ada >= in_ada)?,
  }
}
