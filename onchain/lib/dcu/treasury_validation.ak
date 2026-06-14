use aiken/collection/dict
use aiken/collection/list
use aiken_design_patterns/multi_utxo_indexer
use cardano/address.{Script, VerificationKey}
use cardano/assets.{PolicyId, Value, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use dcu/cip68
use dcu/group.{GroupCip68Datum, GroupDatum, Pull}
use dcu/treasury.{
  DefaultState, PenaltyState, TreasuryDatum, TreasuryState, max_grace_extensions,
}
use dcu/treasury_utils.{
  ada_reserve_conserved, contributable_in, count_active_members,
  find_group_token_name, member_has_user_token, treasury_output_clean,
}
use dcu/utils.{find_own_input, get_lower_bound, only_allowed_policies}

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
  trusted_group_policy: PolicyId,
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

  // [security C1/C2]: the group input MUST sit at the trusted group script (from the
  // protocol settings UTxO) — not merely any script presenting a token with the right
  // name. Defeats a fake always-succeeds "group" minted under an attacker policy.
  expect
    group_input.output.address.payment_credential == Script(
      trusted_group_policy,
    )
  let group_policy_id = trusted_group_policy

  // [spec JoinGroup 4]: treasury output at script address
  expect Some(treasury_output) = list.at(outputs, treasury_output_index)
  expect InlineDatum(treasury_datum_data) = treasury_output.datum
  expect  
      TreasuryState {
        member_reference_tokenname,
        group_reference_tokenname,
        rounds_paid,
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

  // [spec JoinGroup 6d]: claimable_balance == 0 (fresh member, nothing earmarked yet)
  let no_claimable = claimable_balance == 0

  // [spec JoinGroup NEW]: group output at group_output_index has member_count + 1 —
  //   ensures the Group validator's MemberJoin redeemer atomically updates member_count
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(go_data) = group_output.datum
  expect GroupCip68Datum { extra: updated_group, .. } = go_data
  let member_count_incremented = updated_group.member_count == group.member_count + 1
  // [spec JoinGroup NEW]: the active set grows by 1 alongside member_count (a fresh
  // member is in TreasuryState). Group validator pins the full datum; this is
  // defense-in-depth so the treasury cannot mint a member without the active count rising.
  let active_count_incremented = updated_group.active_member_count == group.active_member_count + 1

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
  //   The floor is measured on the *contributable* balance, so an ADA group's treasury
  //   must additionally hold min_ada_reserve to carry the membership token — the round
  //   conservation then drains contributable to 0 (not the raw lovelace) on the last round.
  let fees_locked = contributable_in(
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
    no_claimable?,
    member_count_incremented?,
    active_count_incremented?,
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
// [KNOWN-SCALE-LIMIT — AIK-1/2, documented 2026-06-13]: DistributeRound (and
// NextCycle) consume N member treasury UTxOs in one tx and re-run this per-input
// logic for each, with `count_active_members` folding over the membership registry
// (O(N²) overall). There is NO withdraw-zero delegation (aiken-design-patterns
// `stake_validator`) so the script CPU/mem budget caps the practical group size,
// and duplicate-index protection is the hand-rolled `indices_in_ascending_order`
// rather than `multi_utxo_indexer.one_to_one_no_redeemer`. Both are deliberate
// deferrals (Harun, 2026-06-13: document, do not migrate now). Before raising
// max_members materially, benchmark distribute ex-units and enforce a measured
// ceiling, or adopt the design-patterns primitives. The hand-rolled indexer IS
// correct today; the risk is reviewability/scale, not a live exploit.
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
// WITHDRAW-ZERO: this is the once-per-tx withdraw handler logic. The treasury
// validator is self-coupled (staking hash == spending hash == own_policy_id): the
// `spend` branch for DistributeRound asserts this withdrawal ran, and ALL the heavy
// per-member work happens here exactly once instead of N times (O(N³) → ~O(N)).
//
// Behaviourally identical to the old per-input spend logic: the global checks
// (trusted group binding, group-round increment, pro-rata pot, borrower presence +
// Push payout) run once; the per-input checks (round gate, balance deduction, ICS
// transition, clean output, ADA reserve) run for EVERY treasury input via
// `multi_utxo_indexer.one_to_one_no_redeemer`, which also enforces ascending
// one-to-one indices and that every spent treasury UTxO is covered.
pub fn validate_distribute_withdraw(
  own_policy_id: PolicyId,
  trusted_group_policy: PolicyId,
  round_number: Int,
  group_ref_input_index: Int,
  group_output_index: Int,
  treasury_input_indices: List<Int>,
  treasury_output_indices: List<Int>,
  borrower_output_index: Int,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, reference_inputs, .. } = tx

  // [spec DistributeRound 3]: group spending input with GroupDatum
  expect Some(group_input) = list.at(inputs, group_ref_input_index)
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data

  // [spec DistributeRound 4]: group output has last_distributed_round = round_number
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(go_data) = group_output.datum
  expect GroupCip68Datum { extra: updated_group, .. } = go_data
  let group_round_incremented = updated_group.last_distributed_round == round_number

  // [spec DistributeRound 5]: group output at correct address with ref token
  // [security C1/C2]: group input must sit at the trusted group script (settings UTxO).
  expect
    group_input.output.address.payment_credential == Script(
      trusted_group_policy,
    )
  let group_policy_id = trusted_group_policy
  let expected_group_token_name = find_group_token_name(group_input)
  let group_output_valid = group_output.address == group_input.output.address && assets.quantity_of(
    group_output.value,
    group_policy_id,
    expected_group_token_name,
  ) == 1

  // [spec DistributeRound 6a]: borrower = the contributing member at this round's slot.
  // Deferral was retired: the rotation is fixed and a member's turn is never reordered.
  // "Collect later" is handled by Pull mode (the pot earmarks into the borrower's own
  // treasury via claimable_balance), not by skipping turns — so there is no deferred path.
  let effective_slot = round_number % group.num_rounds

  // The borrower must be present as a contributing spending input in good standing — a
  // defaulted/absent borrower blocks the round in BOTH payout modes (the pot has no
  // legitimate recipient). Computed as an Option and guarded by borrower_present? below.
  let borrower_cred_opt = list.find_map(
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

  let is_pull = group.payout_mode == Pull
  // [spec DistributeRound 7a]: final round suppresses ICS so a drained member can mature-exit.
  let is_last_round = round_number + 1 == group.num_rounds
  let current_time = get_lower_bound(tx)

  // [spec DistributeRound 6c]: PUSH only — borrower output at scheduled member's wallet,
  //   receiving at least total_payout in the contribution asset. Under PULL there is no
  //   wallet output; the pot is earmarked into the borrower's own treasury (enforced per
  //   input below when this UTxO is the borrower's), so these checks are skipped.
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

  // Per-input transition checks, folded over EVERY treasury input↔output pair exactly
  // once. one_to_one_no_redeemer enforces ascending one-to-one indices (subsuming the
  // old indices_in_ascending_order checks) AND that every spent treasury UTxO is covered.
  // The closure returns Bool; a violation makes the indexer fail (crash), so per-input
  // negative tests must use `fail`, not `!`.
  let io_pairs =
    list.map(
      list.zip(treasury_input_indices, treasury_output_indices),
      fn(p) {
        let (i, o) = p
        Pair(i, o)
      },
    )
  let per_input_valid =
    multi_utxo_indexer.one_to_one_no_redeemer(
      io_pairs,
      own_policy_id,
      inputs,
      outputs,
      fn(_in_idx, own_input, _out_idx, own_output) {
        // [spec DistributeRound 1]: input datum must be TreasuryState. Carries
        // assigned_slot + member_payment_credential into any DefaultState transition.
        expect InlineDatum(in_datum_data) = own_input.output.datum
        expect TreasuryState {
          member_reference_tokenname,
          group_reference_tokenname,
          assigned_slot,
          member_payment_credential,
          rounds_paid,
          claimable_balance,
        } = in_datum_data

        // [spec DistributeRound 2]: member hasn't been processed for this round yet
        let member_at_correct_round = rounds_paid == round_number

        // [spec DistributeRound 7]: own output datum
        expect InlineDatum(output_datum_data) = own_output.datum
        expect output_datum: TreasuryDatum = output_datum_data

        // [spec DistributeRound 7b]: contributable balance (excludes ADA reserve), so the
        // -fee conservation is reserve-invariant and the ICS threshold fires on spendable
        // shortfall; final round lands contributable at 0 with the reserve carrying the token.
        let input_bal =
          contributable_in(
            own_input.output.value,
            group.contribution_fee_policyid,
            group.contribution_fee_assetname,
          )
        let output_bal =
          contributable_in(
            own_output.value,
            group.contribution_fee_policyid,
            group.contribution_fee_assetname,
          )

        // is_borrower_treasury is decided purely from immutable datum (assigned_slot) vs the
        // group-derived effective_slot, so it cannot be spoofed.
        let is_borrower_treasury = assigned_slot == effective_slot

        // [spec DistributeRound 7b]: every member debited contribution_fee; under Pull the
        // borrower's OWN treasury is also credited total_payout (conservation pins all other
        // treasuries to -fee, so released fees can only land here — no skim possible).
        let balance_deducted =
          if is_pull && is_borrower_treasury {
            output_bal == input_bal - group.contribution_fee + total_payout
          } else {
            output_bal == input_bal - group.contribution_fee
          }

        // [spec DistributeRound 7a]: ICS transition only below threshold AND not last round.
        let transition_to_ics =
          output_bal < group.contribution_fee && !is_last_round

        let output_datum_correct =
          if transition_to_ics {
            output_datum == DefaultState {
              group_reference_tokenname,
              member_reference_tokenname,
              grace_expires_at: current_time + group.grace_period_length,
              grace_extensions_used: 0,
              rounds_paid: round_number + 1,
              assigned_slot,
              member_payment_credential,
              // [carry-forward]: a defaulter is always a non-borrower (borrower balance rises
              // by total_payout, never below fee), so the earmark carries through unchanged.
              claimable_balance,
            }
          } else {
            expect TreasuryState {
              rounds_paid: output_rounds_paid,
              claimable_balance: output_claimable_balance,
              ..
            } = output_datum
            // [security]: claimable_balance is pinned. Under Push (and every non-borrower
            // under Pull) preserved exactly — else a caller could inflate their own earmark
            // and later drain it via ClaimPayout. Under Pull the borrower's OWN treasury
            // accrues exactly total_payout (matching balance_deducted above).
            let expected_claimable =
              if is_pull && is_borrower_treasury {
                claimable_balance + total_payout
              } else {
                claimable_balance
              }
            output_rounds_paid == round_number + 1 && output_claimable_balance == expected_claimable
          }

        // [spec DistributeRound 8]: clean output at treasury script with membership token —
        // exactly the membership token + only ADA + own policy + contribution asset (no skim).
        let treasury_output_ok =
          treasury_output_clean(
            own_output,
            own_policy_id,
            member_reference_tokenname,
            group.contribution_fee_policyid,
          )

        and {
          member_at_correct_round?,
          balance_deducted?,
          output_datum_correct?,
          treasury_output_ok?,
          // [security]: token groups — output keeps ≥ input lovelace; without this a
          // permissionless cranker could skim the min-ADA reserve. No-op for ADA groups.
          ada_reserve_conserved(
            own_input.output.value,
            own_output.value,
            group.contribution_fee_policyid,
          )?,
        }
      },
    )

  and {
    borrower_present?,
    group_round_incremented?,
    group_output_valid?,
    borrower_payout_valid?,
    per_input_valid?,
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
  trusted_group_policy: PolicyId,
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
  // [security C1/C2]: group input must sit at the trusted group script (settings UTxO).
  expect
    group_input.output.address.payment_credential == Script(
      trusted_group_policy,
    )
  let group_policy_id = trusted_group_policy
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

    // Penalty output contains >= penalty_fee of the penalty asset, measured on the
    // contributable balance so an ADA penalty is genuine forfeiture above the min-ADA the
    // PenaltyState UTxO needs to carry its membership token (not min-ADA counted as penalty).
    let penalty_fee_locked = contributable_in(
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
  let admin_token_name = cip68.convert_ref_to_user_token(
    group_reference_tokenname,
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

// ─── Spend: TerminateDefault ──────────────────────────────────────────────────

// validate_terminate_default
// ─────────────────────────────────────────────────────────────────────────────
// Admin removes a member stuck in DefaultState whose grace window (including any
// ExtendGrace extensions) has fully expired. The membership token is burned, the group
// is spent with the Exit redeemer (decrementing member_count and removing the member from
// the registry — re-verified here on the group output), and the forfeited collateral is
// claimed by the admin who builds the tx (its destination is unconstrained, exactly like
// ClaimPenalty). Neutral and fair: termination is time-gated, so grace + extensions are
// always offered first, and admin-only, so it cannot be triggered arbitrarily by peers.
//
// NOTE: self-reference (own UTxO at treasury_input_index) is enforced at the entry point.
//
// [spec TerminateDefault 1]: datum must be DefaultState
// [spec TerminateDefault 2]: group spending input sits at the trusted group script and
//                            links to this treasury (group_reference_tokenname matches)
// [spec TerminateDefault 3]: group output shows member_count - 1 and the member removed
// [spec TerminateDefault 4]: admin holds the group (222) user token
// [spec TerminateDefault 5]: the grace window has fully expired (now > grace_expires_at)
// [spec TerminateDefault 6]: exactly one membership token is burned (forfeiture)
pub fn validate_terminate_default(
  own_policy_id: PolicyId,
  trusted_group_policy: PolicyId,
  group_ref_input_index: Int,
  group_output_index: Int,
  admin_input_index: Int,
  datum: TreasuryDatum,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, mint, .. } = tx

  // [spec TerminateDefault 1]: datum must be DefaultState
  expect  
      DefaultState {
        member_reference_tokenname,
        group_reference_tokenname,
        grace_expires_at,
        ..
      }
    = datum

  // [spec TerminateDefault 2]: group spending input at the trusted group script (C1/C3).
  expect Some(group_input) = list.at(inputs, group_ref_input_index)
  expect
    group_input.output.address.payment_credential == Script(
      trusted_group_policy,
    )
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data
  let expected_group_token_name = find_group_token_name(group_input)
  let group_link_valid = group_reference_tokenname == expected_group_token_name

  // [spec TerminateDefault 3]: group output decrements member_count and drops the member
  // from the registry. The group is also spent with the Exit redeemer, which enforces the
  // same transition independently — this check keeps the treasury self-sufficient so the
  // membership token can never be burned without the count being corrected (no ghost member).
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect group_output.address == group_input.output.address
  expect InlineDatum(go_data) = group_output.datum
  expect GroupCip68Datum { extra: updated_group, .. } = go_data
  let member_removed = updated_group.member_count == group.member_count - 1 && !list.any(
    updated_group.member_token_names,
    fn(n) { n == member_reference_tokenname },
  )

  // [spec TerminateDefault 4]: admin holds the group (222) user token derived from the
  // group reference token name. [security C3] the trusted policy comes from settings.
  let admin_token_name = cip68.convert_ref_to_user_token(
    group_reference_tokenname,
  )
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let admin_authorized = assets.quantity_of(
    admin_input.output.value,
    trusted_group_policy,
    admin_token_name,
  ) == 1

  // [spec TerminateDefault 5]: the grace window (incl. extensions) has fully expired.
  let grace_expired = get_lower_bound(tx) > grace_expires_at

  // [spec TerminateDefault 6]: exactly one membership token burned (verified in mint too).
  let token_burned = assets.quantity_of(
    mint,
    own_policy_id,
    member_reference_tokenname,
  ) == -1

  and {
    group_link_valid?,
    member_removed?,
    admin_authorized?,
    grace_expired?,
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
  trusted_group_policy: PolicyId,
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
    TreasuryState { member_reference_tokenname, group_reference_tokenname, .. } ->
      (member_reference_tokenname, group_reference_tokenname)
    DefaultState { member_reference_tokenname, group_reference_tokenname, .. } ->
      (member_reference_tokenname, group_reference_tokenname)
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
  expect Some(group_ref_input) = list.at(
    reference_inputs,
    group_ref_input_index,
  )
  // [security C1]: the group reference input must sit at the trusted group script.
  expect
    group_ref_input.output.address.payment_credential == Script(
      trusted_group_policy,
    )
  expect InlineDatum(group_datum_data) = group_ref_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data
  let group_link_valid = datum_group_tokenname == find_group_token_name(
    group_ref_input,
  )

  expect Some(own_input) = find_own_input(inputs, utxo)

  expect Some(own_output) = list.at(outputs, treasury_output_index)
  expect InlineDatum(output_datum_data) = own_output.datum
  expect output_datum: TreasuryDatum = output_datum_data

  // [spec Contribute 4]: contribution-asset balance must increase (works for ADA and
  // any native token — for ADA groups contribution_fee_policyid == ada_policy_id).
  // Measured on the contributable balance (excludes the ADA reserve) so recovery requires
  // a genuinely spendable fee, not min-ADA masquerading as contribution.
  let input_bal = contributable_in(
    own_input.output.value,
    group.contribution_fee_policyid,
    group.contribution_fee_assetname,
  )
  let output_bal = contributable_in(
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
      claimable_balance,
      ..
    } ->
      // Recovery: transition back to TreasuryState reconstructing the preserved fields,
      // including any earmark (claimable_balance) carried through the default — so a
      // recovered member can still ClaimPayout it. Under Push this is always 0.
      output_datum == TreasuryState {
        group_reference_tokenname,
        member_reference_tokenname,
        assigned_slot,
        rounds_paid,
        member_payment_credential,
        claimable_balance,
      }

    PenaltyState { .. } -> False
  }

  // [spec Contribute 5]: output at treasury script, exact membership token, clean value
  let treasury_output_ok = treasury_output_clean(
    own_output,
    own_policy_id,
    member_reference_tokenname,
    group.contribution_fee_policyid,
  )

  and {
    member_authorized?,
    group_link_valid?,
    datum_correct?,
    treasury_output_ok?,
    balance_increased?,
    recovery_funded?,
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

  expect Some(own_input) = find_own_input(inputs, utxo)

  expect Some(own_output) = list.at(outputs, treasury_output_index)
  expect InlineDatum(output_datum_data) = own_output.datum
  expect output_datum: TreasuryDatum = output_datum_data

  // [spec UpdatePayout 3]: output datum: same but with new credential
  let expected_datum = TreasuryState {
    group_reference_tokenname: upd_group_tn,
    member_reference_tokenname,
    assigned_slot: upd_slot,
    rounds_paid: upd_rounds,
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
        claimable_balance,
      }
    = datum

  // [spec ExtendGrace 2]: extension limit not yet reached
  let extensions_available = grace_extensions_used < max_grace_extensions

  // [spec ExtendGrace 3]: admin auth via group (222) user token
  let admin_token_name = cip68.convert_ref_to_user_token(
    group_reference_tokenname,
  )
  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let admin_authorized = assets.quantity_of(
    admin_input.output.value,
    group_policy_id,
    admin_token_name,
  ) == 1

  expect Some(own_input) = find_own_input(inputs, utxo)

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
    claimable_balance,
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
// WITHDRAW-ZERO: once-per-tx NextCycle validation (see validate_distribute_withdraw for the
// pattern). Behaviourally identical to the old per-input spend logic — the global checks
// (trusted group binding, group reset) run once; the per-input checks (cycle-complete gate,
// datum reset, value preservation, M2 re-funding floor, script output) run for EVERY treasury
// input via multi_utxo_indexer.one_to_one_no_redeemer, which also enforces ascending
// one-to-one indices and full coverage of the spent treasury set.
pub fn validate_next_cycle_withdraw(
  own_policy_id: PolicyId,
  trusted_group_policy: PolicyId,
  group_input_index: Int,
  group_output_index: Int,
  treasury_input_indices: List<Int>,
  treasury_output_indices: List<Int>,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, .. } = tx

  // [spec NextCycle 3]: group spending input with GroupDatum
  expect Some(group_input) = list.at(inputs, group_input_index)
  // [security C1]: group input must sit at the trusted group script (settings UTxO).
  expect
    group_input.output.address.payment_credential == Script(
      trusted_group_policy,
    )
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data

  // [spec NextCycle 4]: group output confirms reset
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(go_data) = group_output.datum
  expect GroupCip68Datum { extra: updated_group, .. } = go_data
  let group_reset = !updated_group.is_started && updated_group.last_distributed_round == -1

  // Per-input reset checks, folded over EVERY treasury input↔output pair exactly once.
  // The indexer enforces ascending one-to-one indices and full coverage; a violation
  // makes it fail (crash), so per-input negative tests use `fail`, not `!`.
  let io_pairs =
    list.map(
      list.zip(treasury_input_indices, treasury_output_indices),
      fn(p) {
        let (i, o) = p
        Pair(i, o)
      },
    )
  let per_input_valid =
    multi_utxo_indexer.one_to_one_no_redeemer(
      io_pairs,
      own_policy_id,
      inputs,
      outputs,
      fn(_in_idx, own_input, _out_idx, own_output) {
        // [spec NextCycle 1]: input datum must be TreasuryState
        expect InlineDatum(in_datum_data) = own_input.output.datum
        expect TreasuryState {
          group_reference_tokenname,
          member_reference_tokenname,
          assigned_slot,
          rounds_paid,
          member_payment_credential,
          claimable_balance,
        } = in_datum_data

        // [spec NextCycle 2]: this member's cycle is complete
        let member_cycle_complete = rounds_paid == group.num_rounds

        // [spec NextCycle 5]: own output datum
        expect InlineDatum(output_datum_data) = own_output.datum
        expect output_datum: TreasuryDatum = output_datum_data

        // [spec NextCycle 5]: reset rounds_paid; all other fields frozen. claimable_balance
        // is preserved — an unclaimed earmark is durable across cycles (value_preserved below
        // also keeps the funds physically in the treasury).
        let expected_datum =
          TreasuryState {
            group_reference_tokenname,
            member_reference_tokenname,
            assigned_slot,
            rounds_paid: 0,
            member_payment_credential,
            claimable_balance,
          }
        let datum_correct = output_datum == expected_datum

        // [spec NextCycle 6]: full value preserved — NextCycle only resets datum counters;
        // no distribution happens here, so no asset (ADA or contribution token) may move.
        let value_preserved = own_output.value == own_input.output.value

        // [spec NextCycle 7 / M2]: re-funding guard — a member cannot enter a new cycle
        // under-collateralized. The treasury must hold at least the JoinGroup collateral floor
        // (contribution_fee × collateral_rounds) in the contribution asset. Value is preserved
        // here, so a depleted member must top up via Contribute BEFORE NextCycle; the round is
        // atomic over all members, so one underfunded member blocks the restart.
        let refunded =
          contributable_in(
            own_output.value,
            group.contribution_fee_policyid,
            group.contribution_fee_assetname,
          ) >= group.contribution_fee * group.collateral_rounds

        // Output at script address with membership token (retention implied by value_preserved).
        let output_at_script =
          own_output.address.payment_credential == Script(own_policy_id)

        and {
          member_cycle_complete?,
          datum_correct?,
          value_preserved?,
          refunded?,
          output_at_script?,
        }
      },
    )

  and {
    group_reset?,
    per_input_valid?,
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
  trusted_group_policy: PolicyId,
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
  expect Some(group_ref_input) = list.at(
    reference_inputs,
    group_ref_input_index,
  )
  // [security C1]: the group reference input must sit at the trusted group script.
  expect
    group_ref_input.output.address.payment_credential == Script(
      trusted_group_policy,
    )
  expect InlineDatum(group_datum_data) = group_ref_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data
  let group_link_valid = group_reference_tokenname == find_group_token_name(
    group_ref_input,
  )

  expect Some(own_input) = find_own_input(inputs, utxo)
  expect Some(own_output) = list.at(outputs, treasury_output_index)
  expect InlineDatum(output_datum_data) = own_output.datum
  expect output_datum: TreasuryDatum = output_datum_data

  // [spec ClaimPayout 4]: output datum identical except claimable_balance reset to 0.
  // Pins every other field (slot, rounds, credential, group/member refs) and prevents a
  // double-claim (the earmark cannot remain set after withdrawal).
  let expected_datum = TreasuryState {
    group_reference_tokenname,
    member_reference_tokenname,
    assigned_slot,
    rounds_paid,
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
