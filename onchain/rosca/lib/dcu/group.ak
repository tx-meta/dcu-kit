use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use dcu/cip68
use dcu/treasury.{DefaultState, ReserveState, TreasuryDatum, TreasuryState}
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
  // Payment credential of the group creator — VerificationKey(pkh) for a wallet
  // or Script(hash) for a multisig/contract. Joining fees are paid directly to
  // this credential at join time, so a multisig-governed group can route fees to
  // the multisig itself. Frozen as a critical field once any member has joined.
  creator_payment_credential: Credential,
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
  // M-of-N member approvals required to authorize a lost-member recovery (absolute count,
  // not a fraction — membership is dynamic). Validated `1 <= recovery_threshold <= max_members`
  // at create and `<= member_count` at execute. Default: ceil(member_count/2).
  recovery_threshold: Int,
  // Mandatory delay (POSIX ms) between proposing a recovery and being allowed to execute it —
  // the veto window in which the real holder can CancelRecovery. Default: 259_200_000 (3 days).
  recovery_timelock: Int,
  // Authoritative rotation slot map, parallel to member_token_names (entry i is member i's
  // frozen slot). [] whenever !is_started; rebuilt to [0..member_count-1] in registry order
  // at every StartGroup; a started exit removes the paired entry (never re-packs), so a
  // vacancy stays visible on the group datum alone.
  member_slots: List<Int>,
  // round_number at which the current era's rotation began. effective_slot and the round
  // time gate are era-relative: (round - era_start_round). 0 at first start; set to
  // last_distributed_round + 1 by each re-sealing StartGroup. round_number itself stays
  // monotonic across eras.
  era_start_round: Int,
  // Minimum POSIX-ms between BeginRecommit and the re-sealing StartGroup — the free-exit
  // (opt-out) window. Default: 259_200_000 (3 days). Frozen once any member has joined.
  recommit_window: Int,
  // One-time amount (in the CONTRIBUTION asset) each joiner pays into the group's
  // mutual reserve at JoinGroup. 0 = off. Immutable after creation. Distinct from
  // joining_fee, which routes to creator_payment_credential.
  reserve_join_levy: Int,
  // Per contributing member per round (in the CONTRIBUTION asset) routed to the
  // mutual reserve at DistributeRound; the round's pot shrinks by the same total.
  // 0 = off. Immutable after creation.
  reserve_round_levy: Int,
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
  // Re-admits a recovering member to the active set: increments active_member_count by 1
  // (member_count and all economic fields frozen). Spent atomically with the treasury
  // Contribute recovery (DefaultState -> TreasuryState) — this redeemer verifies that
  // transition on the named treasury UTxO so active_member_count cannot be inflated without
  // a genuine recovery. This is the ONLY count-changing op that does not already spend the
  // group, so it needs its own redeemer (ICS happens inside Distribute; join/exit/terminate
  // already spend the group).
  Recover {
    group_ref_token_name: AssetName,
    group_input_index: Int,
    group_output_index: Int,
    // The recovering member's treasury: DefaultState input -> TreasuryState output.
    treasury_input_index: Int,
    treasury_output_index: Int,
  }
  // Lost-member recovery: swaps the membership registry entry old (N) -> new (N') when a
  // member's identity is rotated by treasury ExecuteRecovery in the same tx. member_count and
  // active_member_count frozen. The treasury indices couple this registry edit to a genuine
  // rotation: the named treasury input must hold N and the named treasury output must hold N'.
  RecoverMember {
    group_ref_token_name: AssetName,
    group_input_index: Int,
    group_output_index: Int,
    old_member_token_name: AssetName,
    new_member_token_name: AssetName,
    // The member's treasury UTxO holding N (being rotated away).
    treasury_input_index: Int,
    // The rotated treasury UTxO holding N'.
    treasury_output_index: Int,
  }
  // Opens the opt-out reset window (Cluster B Recommit). Gated on every remaining member
  // being clean AND (a completed lap OR the next round's slot being provably vacant — the
  // halt case). Sets is_started=False (blocks distribute, re-opens joining, makes every
  // exit free) and clears member_slots; StartGroup re-seals after recommit_window elapses.
  // Appended LAST to keep the Constr indices of all existing variants stable.
  BeginRecommit {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
    group_output_index: Int,
    // The group's reserve UTxO as a REFERENCE input — the clean gate additionally
    // requires standin_rounds == 0 (owed default cover must finish paying out
    // before a lap resets the rotation math). Appended field.
    reserve_ref_input_index: Int,
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
    // [spec CreateGroup 13]: creator_payment_credential carries a valid 28-byte hash,
    // whether it is a wallet key (VerificationKey) or a multisig/contract (Script)
    when datum.creator_payment_credential is {
      VerificationKey(h) -> bytearray.length(h) == 28
      Script(h) -> bytearray.length(h) == 28
    }?,
    // [spec CreateGroup 16]: collateral_rounds in [1, max_members]
    // 1 = PerRound (default), max_members = FullUpfront, k = partial.
    (datum.collateral_rounds >= 1)?,
    (datum.collateral_rounds <= datum.max_members)?,
    (datum.recovery_threshold >= 1)?,
    (datum.recovery_threshold <= datum.max_members)?,
    (datum.recovery_timelock >= 0)?,
    // [spec Recommit]: slots are assigned at StartGroup — the map is empty until sealed,
    // the era counter starts at 0, and the opt-out window length is non-negative
    (datum.member_slots == [])?,
    (datum.era_start_round == 0)?,
    (datum.recommit_window >= 0)?,
    // [spec Reserve C2]: levies are non-negative; 0 = off. Frozen once any member has
    // joined by the record-freeze below, like every other economic field.
    (datum.reserve_join_levy >= 0)?,
    (datum.reserve_round_levy >= 0)?,
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
  let metadata_frozen = output_metadata == input_metadata && output_version == input_version
  let only_is_active_differs = updated_datum == GroupDatum {
    ..current_datum,
    is_active: updated_datum.is_active,
  }

  let is_safe_update = current_datum.member_count == 0 || metadata_frozen && only_is_active_differs

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
    // [spec Recommit]: slot map managed by StartGroup/MemberExit; era counter by StartGroup
    (updated_datum.member_slots == current_datum.member_slots)?,
    (updated_datum.era_start_round == current_datum.era_start_round)?,
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
// Removes `target` from the registry and its same-index slot entry in one pass.
// Slots may be [] (pre-start or recommit window) — then only the name is removed and the
// map stays []. Names are unique (double-join is prevented), so first-match removal is
// equivalent to a filter but keeps the two lists positionally paired.
pub fn remove_paired(
  names: List<AssetName>,
  slots: List<Int>,
  target: AssetName,
) -> (List<AssetName>, List<Int>) {
  when names is {
    [] -> ([], slots)
    [n, ..ns] ->
      when slots is {
        [] -> (list.filter(names, fn(x) { x != target }), [])
        [s, ..ss] ->
          if n == target {
            (ns, ss)
          } else {
            let (rest_names, rest_slots) = remove_paired(ns, ss, target)
            ([n, ..rest_names], [s, ..rest_slots])
          }
      }
  }
}

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

  // [security MemberExit 6 / D3]: the member's treasury must be a spending input. Its INPUT
  // datum decides the active_member_count transition:
  //   TreasuryState leaver (ExitGroup)                       → was active   → active - 1
  //   DefaultState/PenaltyState leaver (TerminateDefault /   → already left → active unchanged
  //   ClaimPenalty)                                            active at ICS
  // TerminateDefault spends the group with THIS Exit redeemer; without the branch it would
  // double-decrement active_member_count, driving it below the true active count and bricking
  // distribution (spent_set_complete could never be satisfied again).
  let member_treasury_input = list.find(
    inputs,
    fn(i) {
      assets.quantity_of(i.output.value, treasury_policy_id, member_token_name) == 1
    },
  )
  let member_was_active = when member_treasury_input is {
    Some(ti) -> {
      expect InlineDatum(d) = ti.output.datum
      expect td: TreasuryDatum = d
      when td is {
        TreasuryState { .. } -> True
        _ -> False
      }
    }
    None -> False
  }

  // [spec Exit 4]: group output at script address with ref token
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated_cip68: GroupCip68Datum = output_datum_data

  // [spec Exit 2 & 5]: member_count decrements by 1; member removed from registry;
  // all other fields frozen; metadata and version preserved
  // [spec Recommit]: the paired slot entry leaves with the name (no re-pack — a started
  // group's vacancy stays visible in member_slots).
  let (remaining_names, remaining_slots) = remove_paired(
    current.member_token_names,
    current.member_slots,
    member_token_name,
  )
  let expected = GroupCip68Datum {
    metadata,
    version,
    extra: GroupDatum {
      ..current,
      member_count: current.member_count - 1,
      // [spec Exit 5b / D3]: active set shrinks by 1 ONLY if the leaver was active
      // (TreasuryState). A defaulter (DefaultState/PenaltyState) already left active at ICS,
      // so terminating/penalty-claiming them must NOT decrement again — see member_was_active.
      active_member_count: if member_was_active {
        current.active_member_count - 1
      } else {
        current.active_member_count
      },
      member_token_names: remaining_names,
      member_slots: remaining_slots,
    },
  }

  // [security]: ADA must not decrease
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy
  let output_clean_value = output_holds_only_own(group_output.value, policy_id)

  // [security MemberExit 6]: the member's treasury must be a spending input (found above).
  let member_token_authenticated = member_treasury_input != None

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

  // [spec Recommit re-seal]: when sealing a recommit window (rounds have run before),
  // the opt-out window must have fully elapsed — start_time carries the window-open
  // time while !is_started. A fresh group (last_distributed_round == -1) has no window.
  let window_elapsed = current.last_distributed_round < 0 || current_time >= current.start_time + current.recommit_window
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
      // [spec Recommit re-seal]: fresh FCFS slots by registry order. The registry is
      // newest-first, so slots count DOWN: the earliest joiner (list tail) gets slot 0
      // and borrows first. A fresh group gets the same map — one code path seals both.
      member_slots: list.reverse(list.range(0, current.member_count - 1)),
      // The new era's rotation is re-based at the next monotonic round: 0 on a fresh
      // group (last_distributed_round == -1), continuation otherwise.
      era_start_round: current.last_distributed_round + 1,
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
    window_elapsed?,
    (group_output.address == group_input.output.address)?,
    (dict.to_pairs(assets.tokens(group_output.value, policy_id)) == [
      Pair(group_ref_token_name, 1),
    ])?,
    output_clean_value?,
    (updated_cip68 == expected)?,
    (out_ada >= in_ada)?,
  }
}

// validate_begin_recommit
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check enforced at entry point.
//
// Opens the opt-out reset window (Cluster B). From here the EXISTING rules do the
// rest automatically: distribute is blocked (is_started gate), joining re-opens
// (!is_started), and every member's exit is free (pre-start exit rule) — legitimate
// because the gate below guarantees every remaining member is clean. StartGroup
// re-seals with fresh FCFS slots and a new era once recommit_window has elapsed.
//
// [spec Recommit 4 gate 1]: group is started and active
// [spec Recommit 4 gate 2]: active_member_count == member_count — nobody defaulting,
//   and (lockstep invariant) everyone settled through last_distributed_round.
//   The reset is never a defaulter escape hatch.
// [spec Recommit 4 gate 3]: a completed lap of the current era, OR the next round's
//   slot is absent from member_slots — the rotation is provably halted (D10) and no
//   distribute can ever run again.
// [spec Recommit 4 effect]: is_started=False; start_time carries the window-open time
//   (tx lower bound; is_started disambiguates its meaning); member_slots cleared.
//   Everything else — counters, registry, funds — unchanged.
pub fn validate_begin_recommit(
  policy_id: PolicyId,
  treasury_policy_id: PolicyId,
  group_ref_token_name: AssetName,
  admin_input_index: Int,
  group_input_index: Int,
  group_output_index: Int,
  reserve_ref_input_index: Int,
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

  // Admin holds the user (222) token — same authority that starts the group.
  let admin_authorized = group_admin_authorized(
    inputs,
    admin_input_index,
    policy_id,
    group_ref_token_name,
  )

  // [spec Reserve §5]: owed default cover must finish paying out before a reset —
  // the group's reserve (located by its deterministic token under the treasury
  // policy, read-only) must show standin_rounds == 0.
  expect Some(reserve_ref) = list.at(
    tx.reference_inputs,
    reserve_ref_input_index,
  )
  let reserve_token_name = cip68.convert_ref_to_reserve_token(
    group_ref_token_name,
  )
  expect
    assets.quantity_of(
      reserve_ref.output.value,
      treasury_policy_id,
      reserve_token_name,
    ) == 1
  expect InlineDatum(reserve_datum_data) = reserve_ref.output.datum
  expect ReserveState { standin_rounds, .. }: TreasuryDatum = reserve_datum_data
  let no_pending_cover = standin_rounds == 0

  let next_era_round = current.last_distributed_round + 1 - current.era_start_round
  let at_boundary = next_era_round % current.num_rounds == 0
  let next_slot = next_era_round % current.num_rounds
  let slot_vacant = !list.has(current.member_slots, next_slot)

  let current_time = get_lower_bound(tx)
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated_cip68: GroupCip68Datum = output_datum_data

  let expected = GroupCip68Datum {
    metadata,
    version,
    extra: GroupDatum {
      ..current,
      is_started: False,
      start_time: current_time,
      member_slots: [],
    },
  }

  // [security]: ADA must not decrease
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)

  // [security]: output holds only ADA + own policy
  let output_clean_value = output_holds_only_own(group_output.value, policy_id)

  and {
    admin_authorized?,
    no_pending_cover?,
    current.is_started?,
    current.is_active?,
    (current.active_member_count == current.member_count)?,
    (at_boundary || slot_vacant)?,
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

  // [spec DistributeRound 4 / Recommit]: time gate — round can't run before its scheduled
  // start. ERA-RELATIVE: start_time is re-set at each re-seal, so the schedule is measured
  // from the era's first round, not the monotonic global counter.
  let current_time = get_lower_bound(tx)
  let round_start_time = current.start_time + (
    round_number - current.era_start_round
  ) * current.interval_length
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

// validate_recover_group
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check enforced at entry point.
//
// Re-admits a recovering member to the active set. Spent atomically with the treasury
// Contribute recovery; this handler verifies the DefaultState -> TreasuryState transition on
// the named treasury UTxO so active_member_count cannot be inflated without a real recovery.
//
// [spec Recover 1]: group input holds the ref token
// [spec Recover 2]: group output: active_member_count + 1, all other fields frozen
// [spec Recover 3]: active_member_count + 1 <= member_count (cannot exceed total membership)
// [spec Recover 4]: treasury input is DefaultState; treasury output is TreasuryState; same member
// [security]: ADA must not decrease; output holds only ADA + own policy
pub fn validate_recover_group(
  policy_id: PolicyId,
  treasury_policy_id: PolicyId,
  group_ref_token_name: AssetName,
  group_input_index: Int,
  group_output_index: Int,
  treasury_input_index: Int,
  treasury_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
) -> Bool {
  // [spec Recover 1]: group input holds the ref token
  let (group_input, GroupCip68Datum { metadata, version, extra: current }) = load_group_input(
    inputs,
    group_input_index,
    policy_id,
    group_ref_token_name,
  )

  // [spec Recover 2]: only active_member_count changes (+1); metadata and version preserved
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated_cip68: GroupCip68Datum = output_datum_data
  let expected = GroupCip68Datum {
    metadata,
    version,
    extra: GroupDatum {
      ..current,
      active_member_count: current.active_member_count + 1,
    },
  }

  // [spec Recover 4]: the named treasury UTxO transitions DefaultState -> TreasuryState (the
  // genuine recovery), tying this active bump to an actual member rejoining the active set.
  expect Some(treasury_in) = list.at(inputs, treasury_input_index)
  expect InlineDatum(t_in_data) = treasury_in.output.datum
  expect t_in_datum: TreasuryDatum = t_in_data
  expect DefaultState { member_reference_tokenname: in_member_tn, .. } = t_in_datum
  let treasury_in_authentic = assets.quantity_of(
    treasury_in.output.value,
    treasury_policy_id,
    in_member_tn,
  ) == 1

  expect Some(treasury_out) = list.at(outputs, treasury_output_index)
  expect InlineDatum(t_out_data) = treasury_out.datum
  expect t_out_datum: TreasuryDatum = t_out_data
  expect TreasuryState { member_reference_tokenname: out_member_tn, .. } = t_out_datum
  let recovery_same_member = in_member_tn == out_member_tn
  // [security]: the recovered output must sit at the treasury script (same policy as the
  // spent treasury input) — defense-in-depth so Recover is self-sufficient rather than relying
  // solely on the coupled Contribute handler to place the output correctly.
  let recovery_output_at_treasury = treasury_out.address.payment_credential == Script(
    treasury_policy_id,
  )

  // [security]: ADA must not decrease; output at same script with ref token; clean value
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)
  let output_clean_value = output_holds_only_own(group_output.value, policy_id)

  and {
    // [spec Recover 3]: cannot exceed total membership
    (current.active_member_count + 1 <= current.member_count)?,
    treasury_in_authentic?,
    recovery_output_at_treasury?,
    recovery_same_member?,
    (group_output.address == group_input.output.address)?,
    (assets.quantity_of(group_output.value, policy_id, group_ref_token_name) == 1)?,
    output_clean_value?,
    (updated_cip68 == expected)?,
    (out_ada >= in_ada)?,
  }
}

// validate_recover_member
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check enforced at entry point.
//
// Group-side half of lost-member identity rotation: swaps the membership registry
// entry old (N) -> new (N') when the treasury-side ExecuteRecovery (quorum + timelock +
// veto, Task 2.6 — not yet implemented) rotates the member's account token in the same
// tx. This handler does NOT re-check authority; it only couples the registry edit to a
// genuine treasury rotation via token presence, so the registry can never be edited
// without a real recovery actually happening.
//
// [spec RecoverMember 1]: group input holds the ref token
// [spec RecoverMember 2]: N must be present in the input registry
// [spec RecoverMember 3]: N' must NOT already be present in the input registry (no collision)
// [spec RecoverMember 4]: output registry == input registry with N removed and N' appended;
//                         member_count, active_member_count, and every other field frozen;
//                         metadata and version preserved
// [spec RecoverMember 5]: treasury input at treasury_input_index holds exactly 1 of N
//                         under treasury_policy_id
// [spec RecoverMember 6]: treasury output at treasury_output_index holds exactly 1 of N'
//                         under treasury_policy_id
// [security]: group output at same script address, holds exactly the ref token, ADA not decreased
pub fn validate_recover_member(
  policy_id: PolicyId,
  treasury_policy_id: PolicyId,
  group_ref_token_name: AssetName,
  group_input_index: Int,
  group_output_index: Int,
  old_member_token_name: AssetName,
  new_member_token_name: AssetName,
  treasury_input_index: Int,
  treasury_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
) -> Bool {
  // [spec RecoverMember 1]: group input holds the ref token
  let (group_input, GroupCip68Datum { metadata, version, extra: current }) = load_group_input(
    inputs,
    group_input_index,
    policy_id,
    group_ref_token_name,
  )

  // [spec RecoverMember 2]: N must exist in the current registry — otherwise there is
  // nothing to rotate away from.
  let old_present = list.any(
    current.member_token_names,
    fn(n) { n == old_member_token_name },
  )

  // [spec RecoverMember 3]: N' must not already be a member — prevents collapsing two
  // distinct identities into one registry slot.
  let new_absent = !list.any(
    current.member_token_names,
    fn(n) { n == new_member_token_name },
  )

  // [spec RecoverMember 4]: registry swap IN PLACE — N' takes N's registry position, so
  // the paired member_slots entry (and with it the member's rotation turn) is preserved.
  let swapped_names = list.map(
    current.member_token_names,
    fn(n) {
      if n == old_member_token_name {
        new_member_token_name
      } else {
        n
      }
    },
  )

  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(output_datum_data) = group_output.datum
  expect updated_cip68: GroupCip68Datum = output_datum_data
  let expected = GroupCip68Datum {
    metadata,
    version,
    extra: GroupDatum { ..current, member_token_names: swapped_names },
  }

  // [spec RecoverMember 5]: the member's treasury UTxO holding N is a spending input —
  // ties the registry edit to the rotation that is actually moving the old identity out.
  expect Some(treasury_in) = list.at(inputs, treasury_input_index)
  let treasury_in_holds_old = assets.quantity_of(
    treasury_in.output.value,
    treasury_policy_id,
    old_member_token_name,
  ) == 1

  // [spec RecoverMember 6]: the rotated treasury UTxO holding N' is produced in the same
  // tx. Note: producing this output legitimately requires the treasury ExecuteRecovery path
  // (Task 2.6), which enforces quorum + timelock + veto — this handler only checks token
  // presence and deliberately does not duplicate that authority check.
  expect Some(treasury_out) = list.at(outputs, treasury_output_index)
  let treasury_out_holds_new = assets.quantity_of(
    treasury_out.value,
    treasury_policy_id,
    new_member_token_name,
  ) == 1
  // [security]: the rotated treasury output must sit at the treasury script — token presence
  // alone does not prove the rotated position landed inside the treasury contract (a token
  // under treasury_policy_id can be held at any address). Pinning the address makes this
  // handler self-sufficient rather than trusting the treasury ExecuteRecovery path (Task 2.6)
  // to place the output correctly. Mirrors Recover's recovery_output_at_treasury.
  let treasury_out_at_script = treasury_out.address.payment_credential == Script(
    treasury_policy_id,
  )

  // [security]: ADA must not decrease; output at same script with ref token; clean value
  let in_ada = assets.lovelace_of(group_input.output.value)
  let out_ada = assets.lovelace_of(group_output.value)
  let output_clean_value = output_holds_only_own(group_output.value, policy_id)

  and {
    old_present?,
    new_absent?,
    treasury_in_holds_old?,
    treasury_out_holds_new?,
    treasury_out_at_script?,
    (group_output.address == group_input.output.address)?,
    // [security]: output retains EXACTLY the ref (100) token — prevents account-merge
    // when a second group UTxO is updated in the same tx (Multiple Satisfaction).
    (dict.to_pairs(assets.tokens(group_output.value, policy_id)) == [
      Pair(group_ref_token_name, 1),
    ])?,
    output_clean_value?,
    (updated_cip68 == expected)?,
    (out_ada >= in_ada)?,
  }
}
