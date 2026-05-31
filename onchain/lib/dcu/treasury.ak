use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use dcu/cip68
use dcu/group.{GroupCip68Datum, GroupDatum, Pull}
use dcu/utils.{get_lower_bound}

/// Maximum number of grace window extensions an admin can grant a defaulting member.
pub const max_grace_extensions: Int = 2

/// Treasury Validator Datum (Sum Type)
pub type TreasuryDatum {
  TreasuryState {
    group_reference_tokenname: AssetName,
    member_reference_tokenname: AssetName,
    assigned_slot: Int,
    // Number of distribution rounds this member has contributed to.
    // Starts at 0; incremented by DistributeRound. Used to enforce sequential
    // round processing: each treasury instance must be at rounds_paid == round_number.
    rounds_paid: Int,
    // True when the member has voluntarily signalled they wish to defer their
    // scheduled payout round. Reset to False by DistributeRound regardless of path.
    is_deferred: Bool,
    // Payment key hash of the member's wallet; used in DistributeRound
    // to route the payout to the correct borrower address.
    member_payment_credential: ByteArray,
    // Pull mode only: pot amount (in the contribution asset) earmarked for this
    // member to withdraw via ClaimPayout. 0 at join and under Push mode. On the
    // member's payout round DistributeRound credits `+= total_payout` here (funds
    // physically accumulate in this UTxO); ClaimPayout resets it to 0. Durable until
    // claimed or returned at exit. See [[configurable-payout-mode]] / roadmap Phase 6.
    claimable_balance: Int,
  }
  PenaltyState {
    group_reference_tokenname: AssetName,
    member_reference_tokenname: AssetName,
  }
  // Transition state for members whose balance drops below contribution_fee.
  // The grace window is the opportunity to top up (via Contribute) and recover
  // back to TreasuryState. Admin may extend the window up to max_grace_extensions
  // times. If the window expires without top-up, admin withdraws via ClaimPenalty.
  DefaultState {
    group_reference_tokenname: AssetName,
    member_reference_tokenname: AssetName,
    // POSIX ms timestamp when the current grace window expires.
    grace_expires_at: Int,
    // Number of grace extensions already granted (max = max_grace_extensions).
    grace_extensions_used: Int,
    // rounds_paid at the time of transition — carried for record keeping and
    // restored when the member recovers back to TreasuryState.
    rounds_paid: Int,
    // Rotation slot — preserved so TreasuryState can be fully reconstructed on recovery.
    assigned_slot: Int,
    // Payment key hash — preserved for payout routing on recovery.
    member_payment_credential: ByteArray,
  }
}

/// Treasury Validator Redeemer
pub type TreasuryRedeemer {
  JoinGroup {
    group_ref_input_index: Int,
    group_output_index: Int,
    member_input_index: Int,
    treasury_output_index: Int,
  }
  ClaimPenalty {
    // Group UTxO as a reference input — not spent, only read to derive
    // the group policy_id for admin token verification. Same pattern as ExtendGrace.
    group_ref_input_index: Int,
    // Admin input holding the group (222) user token.
    admin_input_index: Int,
  }
  DistributeRound {
    // Sequential round number; must equal group.last_distributed_round + 1.
    round_number: Int,
    // Group UTxO spending input — updated to increment last_distributed_round.
    group_ref_input_index: Int,
    // Index of the group output (updated last_distributed_round).
    group_output_index: Int,
    treasury_input_indices: List<Int>,
    treasury_output_indices: List<Int>,
    borrower_output_index: Int,
  }
  ExitGroup {
    group_ref_input_index: Int,
    group_output_index: Int,
    member_input_index: Int,
    treasury_input_index: Int,
    penalty_output_index: Int,
  }
  // Member tops up their treasury balance to remain above contribution_fee.
  Contribute {
    // Group UTxO as a reference input — read for the contribution asset + fee.
    group_ref_input_index: Int,
    member_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
  }
  // Member signals they wish to defer their scheduled payout round.
  // The is_deferred flag is set True here and reset by DistributeRound.
  DeferRound {
    round_number: Int,
    member_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
  }
  // Member updates their payout destination credential.
  UpdatePayout {
    member_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
  }
  // Admin grants a grace window extension to a member in DefaultState.
  // grace_period_length (from the group datum) is passed from the entry point.
  ExtendGrace {
    group_ref_input_index: Int,
    admin_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
  }
  // Resets a treasury UTxO after all rounds have been distributed, preparing
  // it for the next rotation cycle. Must be called atomically with the group
  // NextCycle handler (group is spent in the same tx and output shows reset).
  NextCycle {
    group_input_index: Int,
    group_output_index: Int,
    treasury_input_indices: List<Int>,
    treasury_output_indices: List<Int>,
  }
  // Pull mode: member withdraws their earmarked payout (claimable_balance) to any
  // address. Auth is possession of the member (222) token — bearer model, so a member
  // who lost their original wallet can still claim from a new one holding the token.
  ClaimPayout {
    // Group UTxO as a reference input — read only for the contribution asset identity.
    group_ref_input_index: Int,
    member_input_index: Int,
    treasury_output_index: Int,
  }
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

// member_has_user_token
// Verifies the input at member_input_index holds exactly 1 token of
// member_reference_tokenname under the account_policy_id.
fn member_has_user_token(
  inputs: List<Input>,
  member_input_index: Int,
  member_reference_tokenname: AssetName,
  account_policy_id: PolicyId,
) -> Bool {
  expect Some(member_input) = list.at(inputs, member_input_index)
  assets.quantity_of(
    member_input.output.value,
    account_policy_id,
    member_reference_tokenname,
  ) == 1
}

// find_group_token_name
// Extracts the group reference token name from a group UTxO's value.
fn find_group_token_name(group_input: Input) -> AssetName {
  expect Script(group_policy_id) = group_input.output.address.payment_credential
  expect [Pair(group_token_name, 1)] = dict.to_pairs(
    assets.tokens(group_input.output.value, group_policy_id),
  )
  group_token_name
}

// indices_in_ascending_order
// Verifies that a list of integer indices is strictly ascending.
// Prevents duplicate-index attacks where the same UTxO is listed twice.
fn indices_in_ascending_order(indices: List<Int>) -> Bool {
  when indices is {
    [] -> True
    [_] -> True
    [a, b, ..rest] -> a < b && indices_in_ascending_order([b, ..rest])
  }
}

// only_allowed_policies
// True when every policy present in `value` is one of `allowed`. Replaces the
// strict `policies == [ada_policy_id, own_policy_id]` guard so a group's chosen
// contribution token may be held in the treasury output while still preventing
// unbounded value accumulation (no policy outside the allowed set).
fn only_allowed_policies(value: Value, allowed: List<PolicyId>) -> Bool {
  list.all(assets.policies(value), fn(p) { list.has(allowed, p) })
}

// count_active_members
// Enforces the COMPLETE member set for a distribution round and returns the number of
// contributors. Every name in `member_token_names` must be held by exactly one of:
//   - a SPENDING input whose datum is TreasuryState           → contributing (counted)
//   - a REFERENCE input whose datum is DefaultState/PenaltyState → defaulter (not counted)
// Any member that is missing, or mis-classified (e.g. a healthy TreasuryState parked as a
// reference input to dodge contributing), fails via `expect`/`fail`. This closes the
// partial-set attack: a caller cannot advance a round while silently excluding healthy
// members. The pro-rata pot for the round is `contribution_fee * active_members`.
fn count_active_members(
  member_token_names: List<AssetName>,
  treasury_policy_id: PolicyId,
  inputs: List<Input>,
  reference_inputs: List<Input>,
) -> Int {
  list.foldl(
    member_token_names,
    0,
    fn(name, acc) {
      let holds =
        fn(i: Input) {
          assets.quantity_of(i.output.value, treasury_policy_id, name) == 1
        }
      when list.find(inputs, holds) is {
        // Member is a spending input → must be TreasuryState (contributing this round).
        Some(member_input) -> {
          expect InlineDatum(d) = member_input.output.datum
          expect member_datum: TreasuryDatum = d
          when member_datum is {
            TreasuryState { .. } -> acc + 1
            _ -> fail @"spent member treasury must be TreasuryState in a round"
          }
        }
        // Not spent → must be referenced as a genuine defaulter.
        None -> {
          expect Some(ref_input) = list.find(reference_inputs, holds)
          expect InlineDatum(d) = ref_input.output.datum
          expect ref_datum: TreasuryDatum = d
          when ref_datum is {
            DefaultState { .. } -> acc
            PenaltyState { .. } -> acc
            TreasuryState { .. } ->
              fail @"healthy member must contribute, not be referenced"
          }
        }
      }
    },
  )
}

// ─── Mint: JoinGroup ──────────────────────────────────────────────────────────

// validate_join_group
// ─────────────────────────────────────────────────────────────────────────────
// [spec JoinGroup 0]: group must NOT be started — no late joins after startGroup
// [spec JoinGroup 1]: member input at member_input_index must hold the Account NFT
//                     (user token) under account_policy_id
// [spec JoinGroup 2]: group UTxO at group_ref_input_index is a spending input
//                     with a valid GroupDatum
// [spec JoinGroup 3]: exactly one membership token minted under own policy
// [spec JoinGroup 4]: treasury output at treasury_output_index is at the treasury
//                     script address (Script(own_policy_id))
// [spec JoinGroup 5]: treasury output holds EXACTLY 1 membership token, only ADA +
//                     own policy
// [spec JoinGroup 6]: treasury output datum is TreasuryState with:
//                     - group_reference_tokenname links to the group
//                     - assigned_slot == group.member_count (sequential)
//                     - rounds_paid == 0 (fresh member, no rounds yet)
//                     - is_deferred == False
//                     - member_payment_credential records the member's wallet pkh
// [spec JoinGroup 7]: treasury output holds at least contribution_fee in the
//                     contribution asset (minimum collateral for one round)
// [spec JoinGroup 8]: if joining_fee > 0, admin wallet receives joining fee
// [security        ]: member user token must NOT go to any script address
pub fn validate_join_treasury(
  own_policy_id: PolicyId,
  account_policy_id: PolicyId,
  group_ref_input_index: Int,
  group_output_index: Int,
  member_input_index: Int,
  treasury_output_index: Int,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, mint, .. } = tx

  // [spec JoinGroup 2]: group spending input with valid GroupDatum
  expect Some(group_input) = list.at(inputs, group_ref_input_index)
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data

  // [spec JoinGroup]: group must be active
  let group_active = group.is_active

  // [spec JoinGroup 0]: group must not be started — startGroup seals membership
  let not_started = !group.is_started

  // Extract group policy ID for output validation
  expect Script(group_policy_id) = group_input.output.address.payment_credential

  // [spec JoinGroup 4]: treasury output at script address
  expect Some(treasury_output) = list.at(outputs, treasury_output_index)
  expect InlineDatum(treasury_datum_data) = treasury_output.datum
  expect  
      TreasuryState {
        member_reference_tokenname,
        group_reference_tokenname,
        rounds_paid,
        is_deferred,
        assigned_slot,
        member_payment_credential,
        claimable_balance,
      }: TreasuryDatum
    = treasury_datum_data

  // [spec JoinGroup 3]: exactly 1 membership token minted under own policy
  let minted_tokens = assets.tokens(mint, own_policy_id)
  let exact_mint = dict.get(minted_tokens, member_reference_tokenname) == Some(
    1,
  ) && dict.size(minted_tokens) == 1

  // [spec JoinGroup 6a]: group_reference_tokenname links to the actual group input
  let expected_group_token_name = find_group_token_name(group_input)
  let group_link_valid = group_reference_tokenname == expected_group_token_name

  // [spec JoinGroup 6b]: assigned_slot == group.member_count (sequential slot assignment)
  let slot_valid = assigned_slot == group.member_count

  // [spec JoinGroup 6c]: rounds_paid == 0 (fresh member, no rounds completed yet)
  let rounds_paid_valid = rounds_paid == 0

  // [spec JoinGroup 6d]: is_deferred == False (cannot join already deferred)
  let not_deferred = !is_deferred

  // [spec JoinGroup 6e]: claimable_balance == 0 (fresh member, nothing earmarked yet)
  let no_claimable = claimable_balance == 0

  // [spec JoinGroup NEW]: group output at group_output_index has member_count + 1 —
  //   ensures the Group validator's MemberJoin redeemer atomically updates member_count
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(go_data) = group_output.datum
  expect GroupCip68Datum { extra: updated_group, .. } = go_data
  let member_count_incremented = updated_group.member_count == group.member_count + 1

  // [spec JoinGroup Minor]: group output at correct address with ref token
  let group_output_at_correct_address = group_output.address == group_input.output.address
  let group_output_has_ref_token = assets.quantity_of(
    group_output.value,
    group_policy_id,
    expected_group_token_name,
  ) == 1

  // [spec JoinGroup 7]: treasury output holds at least the configured collateral floor
  //   (contribution_fee * collateral_rounds) in the contribution asset. collateral_rounds
  //   = 1 for traditional PerRound groups, max_members for FullUpfront. Deposits are not
  //   capped — a member may lock more and distribute deducts contribution_fee per round.
  let fees_locked = assets.quantity_of(
    treasury_output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  ) >= group.contribution_fee * group.collateral_rounds

  // [spec JoinGroup 8]: if joining_fee > 0, admin wallet receives joining fee
  let joining_fee_routed = if group.joining_fee == 0 {
    True
  } else {
    list.any(
      outputs,
      fn(o) {
        when o.address.payment_credential is {
          VerificationKey(pkh) ->
            pkh == group.creator_payment_credential && assets.quantity_of(
              o.value,
              group.joining_fee_policyid,
              group.joining_fee_assetname,
            ) >= group.joining_fee
          Script(_) -> False
        }
      },
    )
  }

  // [spec JoinGroup 1]: member input must hold the Account NFT under account_policy_id
  let member_authorized = member_has_user_token(
    inputs,
    member_input_index,
    member_reference_tokenname,
    account_policy_id,
  )

  // [spec JoinGroup 6e]: member_payment_credential records the member's wallet pkh
  expect Some(member_input_utxo) = list.at(inputs, member_input_index)
  expect VerificationKey(member_pkh) = member_input_utxo.output.address.payment_credential
  let member_cred_matches = member_payment_credential == member_pkh

  // [security]: prevent double-join
  let member_not_duplicate = !list.any(
    group.member_token_names,
    fn(n) { n == member_reference_tokenname },
  )

  // [security]: Account NFT (member user token) must NOT go to any script address
  let user_token_at_wallet = list.all(
    outputs,
    fn(o) {
      let has_user_token = assets.quantity_of(
        o.value,
        account_policy_id,
        member_reference_tokenname,
      ) > 0
      if has_user_token {
        when o.address.payment_credential is {
          VerificationKey(_) -> True
          Script(_) -> False
        }
      } else {
        True
      }
    },
  )

  and {
    group_active?,
    not_started?,
    // [spec JoinGroup 1a]: group must not be at capacity
    (group.member_count < group.max_members)?,
    member_not_duplicate?,
    exact_mint?,
    (treasury_output.address.payment_credential == Script(own_policy_id))?,
    // [spec JoinGroup 5]: exact token check
    (dict.to_pairs(assets.tokens(treasury_output.value, own_policy_id)) == [
      Pair(member_reference_tokenname, 1),
    ])?,
    // [security]: only ADA, own policy, and the group's contribution token may be held
    only_allowed_policies(
      treasury_output.value,
      [ada_policy_id, own_policy_id, group.contribution_fee_policyid],
    )?,
    group_link_valid?,
    slot_valid?,
    rounds_paid_valid?,
    not_deferred?,
    no_claimable?,
    member_count_incremented?,
    group_output_at_correct_address?,
    group_output_has_ref_token?,
    fees_locked?,
    joining_fee_routed?,
    member_authorized?,
    member_cred_matches?,
    user_token_at_wallet?,
  }
}

// ─── Mint: ClaimPenalty / ExitGroup (burn) ──────────────────────────────────

// validate_claim_penalty_mint
// ─────────────────────────────────────────────────────────────────────────────
// [spec ClaimPenalty 1]: exactly one membership token is burned under this policy.
//   Covers both PenaltyWithdraw (ClaimPenalty redeemer) and mature ExitGroup burn.
// [security]: no net minting — prevents burn-and-remint attack.
pub fn validate_claim_penalty_mint(own_policy_id: PolicyId, mint: Value) -> Bool {
  let minted_tokens = assets.tokens(mint, own_policy_id)
  // Exactly one entry, with quantity -1
  expect [Pair(_, qty)] = dict.to_pairs(minted_tokens)
  (qty == -1)?
}

// ─── Spend: DistributeRound ───────────────────────────────────────────────────

// validate_distribute
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check (own UTxO is at one of treasury_input_indices) is
//       enforced at the entry point before this function.
//
// [spec DistributeRound 1]: datum must be TreasuryState
// [spec DistributeRound 2]: member.rounds_paid == round_number (hasn't paid this round)
// [spec DistributeRound 3]: group spending input at group_ref_input_index
// [spec DistributeRound 4]: group output shows last_distributed_round = round_number
// [spec DistributeRound 5]: group output at correct address with ref token
// [spec DistributeRound 6]: borrower output at member with assigned_slot == current_slot
//                           and receives total payout in contribution asset
// [spec DistributeRound 7]: own output: rounds_paid + 1, is_deferred = False, balance
//                           reduced by contribution_fee in the contribution asset
// [spec DistributeRound 8]: own output at script address with membership token
// [security]: treasury_input_indices and treasury_output_indices strictly ascending
pub fn validate_distribute_treasury(
  own_policy_id: PolicyId,
  round_number: Int,
  group_ref_input_index: Int,
  group_output_index: Int,
  treasury_input_indices: List<Int>,
  treasury_output_indices: List<Int>,
  borrower_output_index: Int,
  datum: TreasuryDatum,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, reference_inputs, .. } = tx

  // [spec DistributeRound 1]: datum must be TreasuryState
  // Capture assigned_slot and member_payment_credential so they can be carried
  // into DefaultState — required for recovery back to TreasuryState via Contribute.
  expect  
      TreasuryState {
        member_reference_tokenname,
        group_reference_tokenname,
        assigned_slot,
        member_payment_credential,
        rounds_paid,
        claimable_balance,
        ..
      }
    = datum

  // [spec DistributeRound 2]: member hasn't been processed for this round yet
  let member_at_correct_round = rounds_paid == round_number

  // [spec DistributeRound 3]: group spending input with GroupDatum
  expect Some(group_input) = list.at(inputs, group_ref_input_index)
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data

  // [security]: strictly ascending indices — prevents duplicate-index attacks
  let indices_valid = indices_in_ascending_order(treasury_input_indices)
  let output_indices_valid = indices_in_ascending_order(treasury_output_indices)

  // [spec DistributeRound 4]: group output has last_distributed_round = round_number
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(go_data) = group_output.datum
  expect GroupCip68Datum { extra: updated_group, .. } = go_data
  let group_round_incremented = updated_group.last_distributed_round == round_number

  // [spec DistributeRound 5]: group output at correct address with ref token
  expect Script(group_policy_id) = group_input.output.address.payment_credential
  let expected_group_token_name = find_group_token_name(group_input)
  let group_output_valid = group_output.address == group_input.output.address && assets.quantity_of(
    group_output.value,
    group_policy_id,
    expected_group_token_name,
  ) == 1

  // [spec DistributeRound 6a]: find the primary member (assigned_slot == current_slot)
  // and check whether they have deferred their payout.
  let current_slot = round_number % group.num_rounds
  expect Some((primary_cred, primary_is_deferred)) = list.find_map(
    treasury_input_indices,
    fn(idx) {
      when list.at(inputs, idx) is {
        Some(ti) -> {
          expect InlineDatum(d) = ti.output.datum
          expect td: TreasuryDatum = d
          when td is {
            TreasuryState {
              assigned_slot: slot,
              member_payment_credential: cred,
              is_deferred: deferred,
              ..
            } ->
              if slot == current_slot {
                Some((cred, deferred))
              } else {
                None
              }
            _ -> None
          }
        }
        None -> None
      }
    },
  )

  // [spec DistributeRound 6b]: if the primary member is deferred, route payout to
  // (current_slot + 1) % num_rounds instead; always reset is_deferred after distribute.
  let effective_slot = if primary_is_deferred {
    ( current_slot + 1 ) % group.num_rounds
  } else {
    current_slot
  }

  // Borrower = the contributing member at effective_slot. They must be present as a
  // spending input in good standing — a defaulted/absent borrower blocks the round in
  // BOTH payout modes (the pot has no legitimate recipient). Computed as an Option and
  // guarded explicitly in the final conjunction (borrower_present?) so the check runs
  // regardless of payout mode / evaluation order.
  let borrower_cred_opt = if !primary_is_deferred {
    Some(primary_cred)
  } else {
    list.find_map(
      treasury_input_indices,
      fn(idx) {
        when list.at(inputs, idx) is {
          Some(ti) -> {
            expect InlineDatum(d) = ti.output.datum
            expect td: TreasuryDatum = d
            when td is {
              TreasuryState {
                assigned_slot: slot,
                member_payment_credential: c,
                ..
              } ->
                if slot == effective_slot {
                  Some(c)
                } else {
                  None
                }
              _ -> None
            }
          }
          None -> None
        }
      },
    )
  }
  let borrower_present = borrower_cred_opt != None

  // [spec DistributeRound 6c]: PRO-RATA pot = contribution_fee × active_members.
  // active_members is derived from the group's full membership registry (every member
  // accounted for as a contributing spend or a defaulter reference) — NOT from the
  // caller-supplied treasury_input_indices. This (a) closes the partial-set attack
  // (round cannot advance while excluding healthy members) and (b) prevents under-paying
  // the borrower: released fees (active × fee) must all reach the borrower, none can leak.
  let active_members = count_active_members(
    group.member_token_names,
    own_policy_id,
    inputs,
    reference_inputs,
  )
  let total_payout = active_members * group.contribution_fee

  // [spec DistributeRound 7]: find own corresponding output (matched by own UTxO reference)
  expect Some(own_output_index) = list.find_map(
    list.zip(treasury_input_indices, treasury_output_indices),
    fn(pair) {
      let (in_idx, out_idx) = pair
      when list.at(inputs, in_idx) is {
        Some(ti) ->
          if ti.output_reference == utxo {
            Some(out_idx)
          } else {
            None
          }
        None -> None
      }
    },
  )

  expect Some(own_output) = list.at(outputs, own_output_index)
  expect InlineDatum(output_datum_data) = own_output.datum
  expect output_datum: TreasuryDatum = output_datum_data

  // [spec DistributeRound 7b]: balance reduced by contribution_fee in contribution asset
  expect Some(own_input) = list.find(
    inputs,
    fn(i) { i.output_reference == utxo },
  )
  let input_bal = assets.quantity_of(
    own_input.output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )
  let output_bal = assets.quantity_of(
    own_output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )

  // Payout mode + borrower identity for THIS treasury. Under Pull the pot is earmarked
  // into the borrower's OWN treasury (this UTxO, if it is the scheduled member) rather
  // than paid to a wallet. is_borrower_treasury is decided purely from immutable datum
  // (assigned_slot) vs the group-derived effective_slot, so it cannot be spoofed.
  let is_pull = group.payout_mode == Pull
  let is_borrower_treasury = assigned_slot == effective_slot

  // [spec DistributeRound 7b]: balance change in the contribution asset.
  //   - every member is debited contribution_fee (their own contribution this round)
  //   - under Pull, the borrower's own treasury is ALSO credited total_payout (the pot
  //     physically accumulates here; conservation pins all other treasuries to -fee, so
  //     the released fees can only land here — no skim possible)
  let balance_deducted = if is_pull && is_borrower_treasury {
    output_bal == input_bal - group.contribution_fee + total_payout
  } else {
    output_bal == input_bal - group.contribution_fee
  }

  // [spec DistributeRound 7a]: output datum transitions to DefaultState
  // only when post-round balance is below threshold AND there are future rounds remaining.
  // On the final round (round_number + 1 == num_rounds) a zero-balance member stays
  // in TreasuryState so they can exit via the standard mature-exit burn path.
  let is_last_round = round_number + 1 == group.num_rounds
  let transition_to_ics = output_bal < group.contribution_fee && !is_last_round
  let current_time = get_lower_bound(tx)

  let output_datum_correct = if transition_to_ics {
    output_datum == DefaultState {
      group_reference_tokenname,
      member_reference_tokenname,
      grace_expires_at: current_time + group.grace_period_length,
      grace_extensions_used: 0,
      rounds_paid: round_number + 1,
      assigned_slot,
      member_payment_credential,
    }
  } else {
    expect
        TreasuryState {
          rounds_paid: output_rounds_paid,
          is_deferred: output_is_deferred,
          claimable_balance: output_claimable_balance,
          ..
        }
      = output_datum
    // [security]: claimable_balance is pinned. Under Push (and every non-borrower under
    // Pull) it is preserved exactly — without this a caller could inflate their own earmark
    // and later drain it via ClaimPayout. Under Pull the borrower's OWN treasury accrues
    // exactly total_payout (matching the value credited in balance_deducted above).
    // NOTE (carry-forward): a member carrying a nonzero claimable_balance who transitions to
    // DefaultState loses it — DefaultState has no such field; harmless under Push (always 0),
    // revisit for Pull defaults (carry claimable through DefaultState, or block default while >0).
    let expected_claimable = if is_pull && is_borrower_treasury {
      claimable_balance + total_payout
    } else {
      claimable_balance
    }
    output_rounds_paid == round_number + 1 && !output_is_deferred && output_claimable_balance == expected_claimable
  }

  // [spec DistributeRound 8]: own output at script address with membership token
  let output_at_script = own_output.address.payment_credential == Script(
    own_policy_id,
  )
  // [security]: exact token check — prevents account-merge attacks
  let token_retained = dict.to_pairs(
    assets.tokens(own_output.value, own_policy_id),
  ) == [Pair(member_reference_tokenname, 1)]
  // [security]: only ADA, own policy, and the group's contribution token
  let clean_output_value = only_allowed_policies(
    own_output.value,
    [ada_policy_id, own_policy_id, group.contribution_fee_policyid],
  )

  // [spec DistributeRound 6c]: PUSH only — borrower output at scheduled member's wallet,
  //   receiving at least total_payout in the contribution asset. Under PULL there is no
  //   wallet output; the pot is earmarked into the borrower's own treasury (enforced via
  //   balance_deducted + output_datum_correct above when this UTxO is the borrower's), so
  //   these checks are skipped. borrower_cred is still computed above, which also guards
  //   that the scheduled borrower is present among the contributing inputs.
  let borrower_payout_valid = if is_pull {
    True
  } else {
    expect Some(borrower_cred) = borrower_cred_opt
    expect Some(borrower_output) = list.at(outputs, borrower_output_index)
    let borrower_at_correct_wallet = borrower_output.address.payment_credential == VerificationKey(
      borrower_cred,
    )
    let borrower_receives_total = assets.quantity_of(
      borrower_output.value,
      group.contribution_fee_policyid,
      group.contribution_fee_assetname,
    ) >= total_payout
    borrower_at_correct_wallet? && borrower_receives_total?
  }

  and {
    member_at_correct_round?,
    borrower_present?,
    indices_valid?,
    output_indices_valid?,
    group_round_incremented?,
    group_output_valid?,
    output_datum_correct?,
    output_at_script?,
    token_retained?,
    clean_output_value?,
    balance_deducted?,
    borrower_payout_valid?,
  }
}

// ─── Spend: ExitGroup ─────────────────────────────────────────────────────────

// validate_exit_group
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check (own UTxO at treasury_input_index) is enforced at
//       the entry point before this function is called.
//
// [spec ExitGroup 1]: datum must be TreasuryState
// [spec ExitGroup 2]: member input at member_input_index holds the user token
// [spec ExitGroup 3]: group spending input at group_ref_input_index has GroupDatum
// [spec ExitGroup 4a]: Penalty path (active cycle): penalty output at penalty_output_index
//                      has PenaltyState datum, retains membership token, >= penalty_fee locked
// [spec ExitGroup 4b]: Mature/inactive path: membership token is burned
pub fn validate_exit_treasury(
  own_policy_id: PolicyId,
  account_policy_id: PolicyId,
  group_ref_input_index: Int,
  group_output_index: Int,
  member_input_index: Int,
  penalty_output_index: Int,
  datum: TreasuryDatum,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, mint, .. } = tx

  // [spec ExitGroup 1]: datum must be TreasuryState
  expect  
      TreasuryState {
        member_reference_tokenname,
        group_reference_tokenname,
        ..
      }
    = datum

  // Get current time
  let current_time = get_lower_bound(tx)

  // [spec ExitGroup 3]: group spending input with GroupDatum
  expect Some(group_input) = list.at(inputs, group_ref_input_index)
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data

  // Extract group policy ID
  expect Script(group_policy_id) = group_input.output.address.payment_credential
  let expected_group_token_name = find_group_token_name(group_input)

  // [spec ExitGroup 3]: treasury datum's group_reference_tokenname must match the actual group
  let group_link_valid = group_reference_tokenname == expected_group_token_name

  // [spec ExitGroup 2]: member input holds the Account NFT
  let member_authorized = member_has_user_token(
    inputs,
    member_input_index,
    member_reference_tokenname,
    account_policy_id,
  )

  // Determine exit branch:
  //   pre_cycle  (current_time < start_time)           → free exit, token burned
  //   in_cycle   (active && past start && pre-maturity) → penalty exit, PenaltyState
  //   post_cycle (past maturity || inactive)            → free exit, token burned
  let maturity_time = group.start_time + group.num_rounds * group.interval_length
  let is_early_exit = group.is_active && group.start_time <= current_time && current_time < maturity_time

  // [spec ExitGroup 3]: group output — member_count decrements on BOTH paths
  expect Some(group_output_utxo) = list.at(outputs, group_output_index)
  expect InlineDatum(go_data) = group_output_utxo.datum
  expect GroupCip68Datum { extra: updated_group, .. } = go_data

  // [spec ExitGroup Minor]: group output at correct address with ref token
  let group_output_at_correct_address = group_output_utxo.address == group_input.output.address
  let group_output_has_ref_token = assets.quantity_of(
    group_output_utxo.value,
    group_policy_id,
    expected_group_token_name,
  ) == 1

  if is_early_exit {
    // [spec ExitGroup 4a]: penalty output required
    expect Some(penalty_output) = list.at(outputs, penalty_output_index)
    expect InlineDatum(penalty_datum_data) = penalty_output.datum
    expect  
        PenaltyState { member_reference_tokenname: penalty_member_tn, .. }: TreasuryDatum
      = penalty_datum_data

    // [spec ExitGroup 4a]: penalty output retains membership token (exact check)
    let token_in_penalty = dict.to_pairs(
      assets.tokens(penalty_output.value, own_policy_id),
    ) == [Pair(member_reference_tokenname, 1)]

    // Penalty output is at the treasury script address
    let penalty_at_script = penalty_output.address.payment_credential == Script(
      own_policy_id,
    )

    // Penalty output contains >= penalty_fee of the penalty asset
    let penalty_fee_locked = assets.quantity_of(
      penalty_output.value,
      group.penalty_fee_policyid,
      group.penalty_fee_assetname,
    ) >= group.penalty_fee

    // Penalty datum references the same member token name
    let penalty_datum_matches = penalty_member_tn == member_reference_tokenname

    // [security]: penalty output holds only ADA, own policy, and penalty fee policy
    let clean_penalty_value = list.all(
      assets.policies(penalty_output.value),
      fn(p) {
        p == ada_policy_id || p == own_policy_id || p == group.penalty_fee_policyid
      },
    )

    // Penalty path: member exits immediately, freeing the slot
    let group_count_decremented = updated_group.member_count == group.member_count - 1

    and {
      member_authorized?,
      group_link_valid?,
      token_in_penalty?,
      penalty_at_script?,
      penalty_fee_locked?,
      penalty_datum_matches?,
      clean_penalty_value?,
      group_count_decremented?,
      group_output_at_correct_address?,
      group_output_has_ref_token?,
    }
  } else {
    // [spec ExitGroup 4b]: mature/inactive exit — exactly 1 membership token burned
    let token_burned = dict.to_pairs(assets.tokens(mint, own_policy_id)) == [
      Pair(member_reference_tokenname, -1),
    ]

    // Mature exit: member fully exits, member_count decrements
    let group_count_decremented = updated_group.member_count == group.member_count - 1

    and {
      member_authorized?,
      group_link_valid?,
      token_burned?,
      group_count_decremented?,
      group_output_at_correct_address?,
      group_output_has_ref_token?,
    }
  }
}

// ─── Spend: ClaimPenalty ────────────────────────────────────────────────────

// validate_spend_terminate_group
// ─────────────────────────────────────────────────────────────────────────────
// [spec PenaltyWithdraw 1]: datum must be PenaltyState
// [spec PenaltyWithdraw 2]: membership token is burned (verified in mint handler)
// [spec PenaltyWithdraw 3]: admin must hold the group (222) user token
pub fn validate_claim_penalty(
  own_policy_id: PolicyId,
  datum: TreasuryDatum,
  group_policy_id: PolicyId,
  admin_input_index: Int,
  inputs: List<Input>,
  mint: Value,
) -> Bool {
  // [spec PenaltyWithdraw 1]: datum must be PenaltyState
  expect PenaltyState { member_reference_tokenname, group_reference_tokenname }
    = datum

  // [spec PenaltyWithdraw 3]: admin (222) user token derived from group reference token name
  let admin_token_name = cip68.prefix_222
    |> bytearray.concat(
        bytearray.drop(group_reference_tokenname, cip68.prefix_length),
      )

  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let admin_authorized = assets.quantity_of(
    admin_input.output.value,
    group_policy_id,
    admin_token_name,
  ) == 1

  // [spec PenaltyWithdraw 2]: membership token burned in same tx
  let token_burned = assets.quantity_of(
    mint,
    own_policy_id,
    member_reference_tokenname,
  ) == -1

  and {
    admin_authorized?,
    token_burned?,
  }
}

// ─── Spend: Contribute ────────────────────────────────────────────────────────

// validate_contribute
// ─────────────────────────────────────────────────────────────────────────────
// Member tops up their treasury balance. Two valid input datum states:
//
//   TreasuryState — regular top-up while active. Datum is unchanged.
//
//   DefaultState  — recovery top-up during grace window. The grace window
//                   exists precisely for this purpose. Output datum transitions
//                   back to TreasuryState (using the slot and credential carried
//                   in DefaultState). If the member doesn't recover before grace
//                   expires, the admin may call ClaimPenalty.
//
// PenaltyState cannot receive contributions (member has already forfeited).
//
// [spec Contribute 1]: datum must be TreasuryState or DefaultState
// [spec Contribute 2]: member input holds the Account NFT (user token)
// [spec Contribute 3a]: TreasuryState path — output datum structurally unchanged
// [spec Contribute 3b]: DefaultState path — output datum is TreasuryState (recovery)
// [spec Contribute 4]: contribution-asset balance must increase (member is topping up).
//                      The group reference input supplies the contribution asset + fee.
// [spec Contribute 4b]: DefaultState recovery additionally requires the output balance to
//                      reach contribution_fee — a member cannot recover with a token dust top-up.
// [spec Contribute 5]: treasury output at script address with membership token
// NOTE: the group is a read-only reference input. The group-link check below is
//       defense-in-depth; full robustness against a forged group input requires the
//       trusted group↔treasury binding tracked as ISSUE A (settings NFT).
pub fn validate_contribute(
  own_policy_id: PolicyId,
  account_policy_id: PolicyId,
  group_ref_input_index: Int,
  member_input_index: Int,
  treasury_output_index: Int,
  datum: TreasuryDatum,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, reference_inputs, .. } = tx

  // [spec Contribute 1]: extract member + group token names — valid for both datum states
  let (member_reference_tokenname, datum_group_tokenname) = when datum is {
    TreasuryState {
      member_reference_tokenname,
      group_reference_tokenname,
      ..
    } -> (member_reference_tokenname, group_reference_tokenname)
    DefaultState {
      member_reference_tokenname,
      group_reference_tokenname,
      ..
    } -> (member_reference_tokenname, group_reference_tokenname)
    PenaltyState { .. } -> fail @"PenaltyState cannot receive contributions"
  }

  // [spec Contribute 2]: member auth
  let member_authorized = member_has_user_token(
    inputs,
    member_input_index,
    member_reference_tokenname,
    account_policy_id,
  )

  // Read the group reference input for the contribution asset + fee, and verify it
  // links to this treasury (defense-in-depth — see ISSUE A note above).
  expect Some(group_ref_input) = list.at(reference_inputs, group_ref_input_index)
  expect InlineDatum(group_datum_data) = group_ref_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data
  let group_link_valid = datum_group_tokenname == find_group_token_name(
    group_ref_input,
  )

  expect Some(own_input) = list.find(
    inputs,
    fn(i) { i.output_reference == utxo },
  )

  expect Some(own_output) = list.at(outputs, treasury_output_index)
  expect InlineDatum(output_datum_data) = own_output.datum
  expect output_datum: TreasuryDatum = output_datum_data

  // [spec Contribute 4]: contribution-asset balance must increase (works for ADA and
  // any native token — for ADA groups contribution_fee_policyid == ada_policy_id).
  let input_bal = assets.quantity_of(
    own_input.output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )
  let output_bal = assets.quantity_of(
    own_output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )
  let balance_increased = output_bal > input_bal

  // [spec Contribute 4b]: DefaultState recovery must restore at least contribution_fee —
  // closes the "+1 unit recovery" gap that defeated the grace/default mechanism.
  let recovery_funded = when datum is {
    DefaultState { .. } -> output_bal >= group.contribution_fee
    _ -> True
  }

  // [spec Contribute 3a/3b]: output datum validation differs by input datum state
  let datum_correct = when datum is {
    TreasuryState { .. } ->
      // Regular top-up: datum must be structurally unchanged
      output_datum == datum

    DefaultState {
      group_reference_tokenname,
      assigned_slot,
      rounds_paid,
      member_payment_credential,
      ..
    } ->
      // Recovery: transition back to TreasuryState using the preserved fields
      // NOTE (slice 2): DefaultState carries no claimable_balance, so recovery resets it
      // to 0. Under Push this is always correct (claimable is always 0). For Pull, a member
      // who defaulted while holding an unclaimed earmark loses it here — revisit when wiring
      // Pull defaults (either carry claimable through DefaultState, or block default while
      // claimable > 0).
      output_datum == TreasuryState {
        group_reference_tokenname,
        member_reference_tokenname,
        assigned_slot,
        rounds_paid,
        is_deferred: False,
        member_payment_credential,
        claimable_balance: 0,
      }

    PenaltyState { .. } -> False
  }

  // [spec Contribute 5]: output at script address with membership token
  let output_at_script = own_output.address.payment_credential == Script(
    own_policy_id,
  )
  let token_retained = dict.to_pairs(
    assets.tokens(own_output.value, own_policy_id),
  ) == [Pair(member_reference_tokenname, 1)]
  // [security]: only ADA, own policy, and the group's contribution token may be held
  let clean_output_value = only_allowed_policies(
    own_output.value,
    [ada_policy_id, own_policy_id, group.contribution_fee_policyid],
  )

  and {
    member_authorized?,
    group_link_valid?,
    datum_correct?,
    output_at_script?,
    token_retained?,
    clean_output_value?,
    balance_increased?,
    recovery_funded?,
  }
}

// ─── Spend: DeferRound ────────────────────────────────────────────────────────

// validate_defer_round
// ─────────────────────────────────────────────────────────────────────────────
// Member signals they wish to defer their scheduled payout round.
// The is_deferred flag is set True here; DistributeRound resets it to False.
//
// [spec DeferRound 1]: datum must be TreasuryState
// [spec DeferRound 2]: round_number == datum.rounds_paid (deferring the next round)
// [spec DeferRound 3]: member input holds the Account NFT
// [spec DeferRound 4]: output datum: same but is_deferred = True
// [spec DeferRound 5]: output ADA unchanged; output at script with membership token
pub fn validate_defer_round(
  own_policy_id: PolicyId,
  account_policy_id: PolicyId,
  round_number: Int,
  member_input_index: Int,
  treasury_output_index: Int,
  datum: TreasuryDatum,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, .. } = tx

  // [spec DeferRound 1]: datum must be TreasuryState — destructure all fields for reconstruction
  expect  
      TreasuryState {
        group_reference_tokenname: defer_group_tn,
        member_reference_tokenname,
        assigned_slot: defer_slot,
        rounds_paid,
        is_deferred: currently_deferred,
        member_payment_credential: defer_pkh,
        claimable_balance: defer_claimable,
      }
    = datum

  // [spec DeferRound 2]: deferring the next un-processed round
  let correct_round = round_number == rounds_paid

  // Cannot defer if already deferred (idempotent guard)
  let not_already_deferred = !currently_deferred

  // [spec DeferRound 3]: member auth
  let member_authorized = member_has_user_token(
    inputs,
    member_input_index,
    member_reference_tokenname,
    account_policy_id,
  )

  expect Some(own_input) = list.find(
    inputs,
    fn(i) { i.output_reference == utxo },
  )

  expect Some(own_output) = list.at(outputs, treasury_output_index)
  expect InlineDatum(output_datum_data) = own_output.datum
  expect output_datum: TreasuryDatum = output_datum_data

  // [spec DeferRound 4]: output datum: same but is_deferred = True
  let expected_datum = TreasuryState {
    group_reference_tokenname: defer_group_tn,
    member_reference_tokenname,
    assigned_slot: defer_slot,
    rounds_paid,
    is_deferred: True,
    member_payment_credential: defer_pkh,
    claimable_balance: defer_claimable,
  }
  let datum_correct = output_datum == expected_datum

  // [spec DeferRound 5]: full value preserved — DeferRound only flips a datum flag and
  // must not move ANY asset (ADA or the contribution token). Stronger than the old
  // ADA-only check and native-token-correct.
  let value_preserved = own_output.value == own_input.output.value

  // Output at script address with membership token
  let output_at_script = own_output.address.payment_credential == Script(
    own_policy_id,
  )
  // token retention is implied by value_preserved (output value == input value).

  and {
    correct_round?,
    not_already_deferred?,
    member_authorized?,
    datum_correct?,
    value_preserved?,
    output_at_script?,
  }
}

// ─── Spend: UpdatePayout ────────────────────────────────────────────

// validate_update_payout
// ─────────────────────────────────────────────────────────────────────────────
// Member updates their payout destination to their current wallet address.
// The new credential is derived from the account token input — proving control.
//
// [spec UpdatePayout 1]: datum must be TreasuryState
// [spec UpdatePayout 2]: member input holds the Account NFT
// [spec UpdatePayout 3]: output datum: same but member_payment_credential
//                                   = member's current wallet pkh
// [spec UpdatePayout 4]: output ADA unchanged; output at script with token
pub fn validate_update_payout(
  own_policy_id: PolicyId,
  account_policy_id: PolicyId,
  member_input_index: Int,
  treasury_output_index: Int,
  datum: TreasuryDatum,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, .. } = tx

  // [spec UpdatePayout 1]: datum must be TreasuryState — destructure all fields for reconstruction
  expect  
      TreasuryState {
        group_reference_tokenname: upd_group_tn,
        member_reference_tokenname,
        assigned_slot: upd_slot,
        rounds_paid: upd_rounds,
        is_deferred: upd_deferred,
        claimable_balance: upd_claimable,
        ..
      }
    = datum

  // [spec UpdatePayout 2]: member auth — account token proves identity
  let member_authorized = member_has_user_token(
    inputs,
    member_input_index,
    member_reference_tokenname,
    account_policy_id,
  )

  // Derive the new credential from the member input's wallet address
  expect Some(member_input_utxo) = list.at(inputs, member_input_index)
  expect VerificationKey(new_pkh) = member_input_utxo.output.address.payment_credential

  expect Some(own_input) = list.find(
    inputs,
    fn(i) { i.output_reference == utxo },
  )

  expect Some(own_output) = list.at(outputs, treasury_output_index)
  expect InlineDatum(output_datum_data) = own_output.datum
  expect output_datum: TreasuryDatum = output_datum_data

  // [spec UpdatePayout 3]: output datum: same but with new credential
  let expected_datum = TreasuryState {
    group_reference_tokenname: upd_group_tn,
    member_reference_tokenname,
    assigned_slot: upd_slot,
    rounds_paid: upd_rounds,
    is_deferred: upd_deferred,
    member_payment_credential: new_pkh,
    claimable_balance: upd_claimable,
  }
  let datum_correct = output_datum == expected_datum

  // [spec UpdatePayout 4]: full value preserved — only the payout credential changes,
  // no asset (ADA or contribution token) may move. Native-token-correct.
  let value_preserved = own_output.value == own_input.output.value

  // Output at script address with membership token
  let output_at_script = own_output.address.payment_credential == Script(
    own_policy_id,
  )
  // token retention is implied by value_preserved (output value == input value).

  and {
    member_authorized?,
    datum_correct?,
    value_preserved?,
    output_at_script?,
  }
}

// ─── Spend: ExtendGrace ─────────────────────────────────────────────────

// validate_extend_grace
// ─────────────────────────────────────────────────────────────────────────────
// Admin grants an additional grace window to a member in DefaultState.
// grace_period_length is read from the group datum and passed from the entry point.
//
// [spec ExtendGrace 1]: datum must be DefaultState
// [spec ExtendGrace 2]: grace_extensions_used < max_grace_extensions
// [spec ExtendGrace 3]: admin holds the group (222) user token
// [spec ExtendGrace 4]: output datum: grace_extensions_used + 1,
//                              grace_expires_at + grace_period_length, all else frozen
// [spec ExtendGrace 5]: output ADA unchanged; output at script with token
pub fn validate_extend_grace(
  own_policy_id: PolicyId,
  group_policy_id: PolicyId,
  grace_period_length: Int,
  admin_input_index: Int,
  treasury_output_index: Int,
  datum: TreasuryDatum,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, .. } = tx

  // [spec ExtendGrace 1]: datum must be DefaultState
  expect  
      DefaultState {
        member_reference_tokenname,
        group_reference_tokenname,
        grace_expires_at,
        grace_extensions_used,
        rounds_paid,
        assigned_slot,
        member_payment_credential,
      }
    = datum

  // [spec ExtendGrace 2]: extension limit not yet reached
  let extensions_available = grace_extensions_used < max_grace_extensions

  // [spec ExtendGrace 3]: admin auth via group (222) user token
  let admin_token_name = cip68.prefix_222
    |> bytearray.concat(
        bytearray.drop(group_reference_tokenname, cip68.prefix_length),
      )
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let admin_authorized = assets.quantity_of(
    admin_input.output.value,
    group_policy_id,
    admin_token_name,
  ) == 1

  expect Some(own_input) = list.find(
    inputs,
    fn(i) { i.output_reference == utxo },
  )

  expect Some(own_output) = list.at(outputs, treasury_output_index)
  expect InlineDatum(output_datum_data) = own_output.datum
  expect output_datum: TreasuryDatum = output_datum_data

  // [spec ExtendGrace 4]: output datum with extended grace window; slot and
  // payment credential preserved for potential recovery via Contribute
  let expected_datum = DefaultState {
    group_reference_tokenname,
    member_reference_tokenname,
    grace_expires_at: grace_expires_at + grace_period_length,
    grace_extensions_used: grace_extensions_used + 1,
    rounds_paid,
    assigned_slot,
    member_payment_credential,
  }
  let datum_correct = output_datum == expected_datum

  // [spec ExtendGrace 5]: full value preserved — only the grace window extends,
  // no asset (ADA or contribution token) may move. Native-token-correct.
  let value_preserved = own_output.value == own_input.output.value

  // Output at script address with membership token
  let output_at_script = own_output.address.payment_credential == Script(
    own_policy_id,
  )
  // token retention is implied by value_preserved (output value == input value).

  and {
    extensions_available?,
    admin_authorized?,
    datum_correct?,
    value_preserved?,
    output_at_script?,
  }
}

// ─── Spend: NextCycle ─────────────────────────────────────────────────────────

// validate_next_cycle
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check (own UTxO is at one of treasury_input_indices) is
//       enforced at the entry point before this function.
//
// Resets a treasury UTxO for another rotation cycle. Called atomically with the
// group NextCycle handler: the group is spent in the same tx and the output
// confirms the reset (is_started=False, last_distributed_round=-1).
//
// [spec NextCycle 1]: datum must be TreasuryState
// [spec NextCycle 2]: rounds_paid == group.num_rounds (cycle complete)
// [spec NextCycle 3]: group spending input at group_input_index has GroupDatum
// [spec NextCycle 4]: group output is_started=False and last_distributed_round=-1
// [spec NextCycle 5]: own output datum: rounds_paid=0, is_deferred=False, all else frozen
// [spec NextCycle 6]: output ADA unchanged; output at script address with membership token
// [security]: treasury_input_indices and treasury_output_indices strictly ascending
pub fn validate_next_cycle_treasury(
  own_policy_id: PolicyId,
  group_input_index: Int,
  group_output_index: Int,
  treasury_input_indices: List<Int>,
  treasury_output_indices: List<Int>,
  datum: TreasuryDatum,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, .. } = tx

  // [spec NextCycle 1]: datum must be TreasuryState
  expect  
      TreasuryState {
        group_reference_tokenname,
        member_reference_tokenname,
        assigned_slot,
        rounds_paid,
        member_payment_credential,
        claimable_balance,
        ..
      }
    = datum

  // [spec NextCycle 3]: group spending input with GroupDatum
  expect Some(group_input) = list.at(inputs, group_input_index)
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data

  // [spec NextCycle 2]: this member's cycle is complete
  let member_cycle_complete = rounds_paid == group.num_rounds

  // [spec NextCycle 4]: group output confirms reset
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(go_data) = group_output.datum
  expect GroupCip68Datum { extra: updated_group, .. } = go_data
  let group_reset = !updated_group.is_started && updated_group.last_distributed_round == -1

  // [security]: strictly ascending indices
  let indices_valid = indices_in_ascending_order(treasury_input_indices)
  let output_indices_valid = indices_in_ascending_order(treasury_output_indices)

  // [spec NextCycle 5]: find own output via UTxO reference
  expect Some(own_output_index) = list.find_map(
    list.zip(treasury_input_indices, treasury_output_indices),
    fn(pair) {
      let (in_idx, out_idx) = pair
      when list.at(inputs, in_idx) is {
        Some(ti) ->
          if ti.output_reference == utxo {
            Some(out_idx)
          } else {
            None
          }
        None -> None
      }
    },
  )

  expect Some(own_output) = list.at(outputs, own_output_index)
  expect InlineDatum(output_datum_data) = own_output.datum
  expect output_datum: TreasuryDatum = output_datum_data

  // [spec NextCycle 5]: reset rounds_paid and is_deferred; all other fields frozen.
  // claimable_balance is preserved — an unclaimed earmark is durable across cycles
  // (value_preserved below also keeps the funds physically in the treasury).
  let expected_datum = TreasuryState {
    group_reference_tokenname,
    member_reference_tokenname,
    assigned_slot,
    rounds_paid: 0,
    is_deferred: False,
    member_payment_credential,
    claimable_balance,
  }
  let datum_correct = output_datum == expected_datum

  // [spec NextCycle 6]: full value preserved — NextCycle only resets datum counters;
  // no distribution happens here, so no asset (ADA or contribution token) may move.
  expect Some(own_input) = list.find(
    inputs,
    fn(i) { i.output_reference == utxo },
  )
  let value_preserved = own_output.value == own_input.output.value

  // Output at script address with membership token
  let output_at_script = own_output.address.payment_credential == Script(
    own_policy_id,
  )
  // token retention is implied by value_preserved (output value == input value).

  and {
    member_cycle_complete?,
    group_reset?,
    indices_valid?,
    output_indices_valid?,
    datum_correct?,
    value_preserved?,
    output_at_script?,
  }
}

// ─── Spend: ClaimPayout ───────────────────────────────────────────────────────

// validate_claim_payout
// ─────────────────────────────────────────────────────────────────────────────
// Pull mode: a member withdraws their earmarked payout. The pot accumulated in this
// treasury's value during DistributeRound and is tracked by claimable_balance. The
// member pulls EXACTLY that amount (in the contribution asset) to any address they
// choose at claim time; the collateral and membership token stay locked. Auth is by
// possession of the member (222) token — whoever holds the membership owns the payout,
// which is what makes lost-wallet recovery work without a pre-step.
//
// [spec ClaimPayout 1]: datum must be TreasuryState
// [spec ClaimPayout 2]: member input holds the Account NFT (222 token)
// [spec ClaimPayout 3]: group reference input supplies the contribution asset identity
//                       and links to this treasury (defense-in-depth — see ISSUE A note)
// [spec ClaimPayout 4]: output datum == input with claimable_balance reset to 0; all else frozen
// [spec ClaimPayout 5]: exactly claimable_balance leaves in the contribution asset
//                       (collateral is untouched)
// [spec ClaimPayout 6]: output at script address with membership token; clean value
pub fn validate_claim_payout(
  own_policy_id: PolicyId,
  account_policy_id: PolicyId,
  group_ref_input_index: Int,
  member_input_index: Int,
  treasury_output_index: Int,
  datum: TreasuryDatum,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, reference_inputs, .. } = tx

  // [spec ClaimPayout 1]: datum must be TreasuryState
  expect
      TreasuryState {
        group_reference_tokenname,
        member_reference_tokenname,
        assigned_slot,
        rounds_paid,
        is_deferred,
        member_payment_credential,
        claimable_balance,
      }
    = datum

  // [spec ClaimPayout 2]: member auth via 222 token possession (bearer model)
  let member_authorized = member_has_user_token(
    inputs,
    member_input_index,
    member_reference_tokenname,
    account_policy_id,
  )

  // [spec ClaimPayout 3]: group reference input for the contribution asset identity.
  // The group-link check ties it to this treasury so a forged group ref cannot misdirect
  // the balance measurement (e.g. claim ADA when the contribution asset is a token).
  expect Some(group_ref_input) = list.at(reference_inputs, group_ref_input_index)
  expect InlineDatum(group_datum_data) = group_ref_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data
  let group_link_valid = group_reference_tokenname == find_group_token_name(
    group_ref_input,
  )

  expect Some(own_input) = list.find(
    inputs,
    fn(i) { i.output_reference == utxo },
  )
  expect Some(own_output) = list.at(outputs, treasury_output_index)
  expect InlineDatum(output_datum_data) = own_output.datum
  expect output_datum: TreasuryDatum = output_datum_data

  // [spec ClaimPayout 4]: output datum identical except claimable_balance reset to 0.
  // Pins every other field (slot, rounds, credential, group/member refs, is_deferred) and
  // prevents a double-claim (the earmark cannot remain set after withdrawal).
  let expected_datum = TreasuryState {
    group_reference_tokenname,
    member_reference_tokenname,
    assigned_slot,
    rounds_paid,
    is_deferred,
    member_payment_credential,
    claimable_balance: 0,
  }
  let datum_correct = output_datum == expected_datum

  // [spec ClaimPayout 5]: exactly claimable_balance leaves in the contribution asset.
  // Pinned both ways: the member cannot withdraw more (would drain collateral) or less.
  let input_bal = assets.quantity_of(
    own_input.output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )
  let output_bal = assets.quantity_of(
    own_output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )
  let correct_withdrawal = output_bal == input_bal - claimable_balance

  // [spec ClaimPayout 6]: output at script with the membership token and a clean value.
  let output_at_script = own_output.address.payment_credential == Script(
    own_policy_id,
  )
  let token_retained = dict.to_pairs(
    assets.tokens(own_output.value, own_policy_id),
  ) == [Pair(member_reference_tokenname, 1)]
  let clean_output_value = only_allowed_policies(
    own_output.value,
    [ada_policy_id, own_policy_id, group.contribution_fee_policyid],
  )

  and {
    member_authorized?,
    group_link_valid?,
    datum_correct?,
    correct_withdrawal?,
    output_at_script?,
    token_retained?,
    clean_output_value?,
  }
}
