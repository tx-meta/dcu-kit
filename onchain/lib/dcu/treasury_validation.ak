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
use dcu/recovery.{
  approvals_are_distinct, approvals_are_registry_members,
  collect_signed_approvals, recoveree_signed_for_token,
  signed_account_token_name,
}
use dcu/treasury.{
  DefaultState, PenaltyState, RecoveryRequest, TreasuryDatum, TreasuryState,
  max_grace_extensions,
}
use dcu/treasury_utils.{
  ada_reserve_conserved, contributable_in, count_default_outputs,
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

// ─── Mint: ProposeRecovery ──────────────────────────────────────────────────

// validate_propose_recovery
// ─────────────────────────────────────────────────────────────────────────────
// Opens a lost-member recovery: a member quorum (signature-based, NOT mere
// reference presence) authorises rotating a lost member's identity to a new
// Account-222 token N' that the recoveree controls. Mints exactly 1 token
// under own (treasury) policy named N' and locks it in a fresh RecoveryRequest
// UTxO at the treasury script — authenticated by holding N', the same pattern
// a live treasury UTxO uses for its membership token. Approve/Cancel/Execute
// (Tasks 2.4/2.5/2.6) consume this request; the quorum THRESHOLD is checked at
// Execute, not here — propose only requires len(approvals) >= 1 so async
// approvals (one signer per tx) are possible.
//
// [spec ProposeRecovery 1]: group reference input at group_ref_input_index sits at the
//                           trusted group script; unwrap GroupDatum for recovery_timelock
//                           and the member registry (member_token_names)
// [spec ProposeRecovery 2]: target_token (the lost member, read from the request output's
//                           own datum) must be a real registry member
// [spec ProposeRecovery 3a]: new_member_tokenname (N', read from the request output's own
//                            datum) must NOT already be a member — no collision with an
//                            existing identity
// [spec ProposeRecovery 3b]: the recoveree controls N' — an input or reference input
//                            holds exactly 1 of N' under account_policy_id at a VK
//                            address whose PKH signed (proves control, not mere mention)
// [spec ProposeRecovery 4]: earliest_execution_slot (read from the request output's own
//                           datum) is RECOMPUTED here as get_lower_bound(tx) +
//                           group.recovery_timelock — never trusted from the datum as
//                           given, so the veto window cannot be forged
// [spec ProposeRecovery 5]: every approver_input_indices entry resolves to an input that
//                           holds exactly 1 Account-222 token under account_policy_id at a
//                           VK address whose PKH is in tx.extra_signatories (genuinely
//                           SIGNED — reference-input presence alone proves existence, not
//                           consent, and is rejected)
// [spec ProposeRecovery 5b]: every approval is a registry member; all approvals distinct
//                            (no double-counting one signer); target_token is NOT among
//                            the approvals (the lost member cannot vouch for itself);
//                            at least 1 approval (threshold enforced at Execute, not here)
// [spec ProposeRecovery 6]: exactly 1 token minted under own policy, name == N', nothing
//                           else minted under own policy
// [spec ProposeRecovery 7]: request output at request_output_index sits at the treasury
//                           script, holds exactly {N': 1} + only ADA, and carries a
//                           RecoveryRequest datum equal to the values validated above —
//                           including approvals == EXACTLY the derived signed-approval set
//                           and group_reference_tokenname == the actual group input's token
pub fn validate_propose_recovery(
  own_policy_id: PolicyId,
  account_policy_id: PolicyId,
  trusted_group_policy: PolicyId,
  group_ref_input_index: Int,
  request_output_index: Int,
  approver_input_indices: List<Int>,
  tx: Transaction,
) -> Bool {
  let Transaction {
    inputs,
    reference_inputs,
    outputs,
    mint,
    extra_signatories,
    ..
  } = tx

  // [spec ProposeRecovery 1]: group reference input at the trusted group script.
  // The group is read-only here — ProposeRecovery does not modify the registry (that
  // happens at ExecuteRecovery via the group's RecoverMember redeemer), so the group
  // CANNOT be a spending input (no group redeemer validates a propose). It must be a
  // reference input; group_ref_input_index indexes into reference_inputs.
  expect Some(group_input) = list.at(reference_inputs, group_ref_input_index)
  expect
    group_input.output.address.payment_credential == Script(
      trusted_group_policy,
    )
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data

  // The proposed request's fields all come from the request output's OWN datum —
  // the redeemer carries no parallel copies to compare against (single source of
  // truth), so every field below is read once here and then checked/recomputed.
  expect Some(request_output) = list.at(outputs, request_output_index)
  expect InlineDatum(request_datum_data) = request_output.datum
  expect request_datum: TreasuryDatum = request_datum_data
  expect RecoveryRequest {
    target_token,
    new_member_tokenname,
    new_payment_credential,
    earliest_execution_slot,
    approvals: _approvals,
    ..
  } = request_datum

  // [spec ProposeRecovery 2]: the lost member must be a real registry member
  let target_in_registry = list.any(
    group.member_token_names,
    fn(n) { n == target_token },
  )

  // [spec ProposeRecovery 3a]: N' must not already be a member (no collision)
  let new_not_member = !list.any(
    group.member_token_names,
    fn(n) { n == new_member_tokenname },
  )

  // [spec ProposeRecovery 3b]: the recoveree controls N' — searched across spending
  // AND reference inputs (the redeemer carries no dedicated index for this input;
  // the recoveree need not spend anything to prove control). recoveree_signed_for_token
  // returns Some(pkh) only for a VK-address input holding exactly 1 of N' whose PKH
  // signed; None otherwise. The returned pkh is the recoveree's own signing key, used
  // below to bind new_payment_credential.
  let recoveree_pkh = recoveree_signed_for_token(
    list.concat(inputs, reference_inputs),
    new_member_tokenname,
    account_policy_id,
    extra_signatories,
  )

  // [spec ProposeRecovery 3c]: bind the recovered member's payout address to the
  // recoveree's OWN signing key. Holding N' and signing only proves control of N',
  // not that the new_payment_credential written into the request is the recoveree's —
  // without this a malicious quorum could route the recovered member's future Push
  // payouts to an attacker's address. The recovered member can still re-point it later
  // via UpdatePayout, so this is a binding, not a limitation. None ⇒ no signed N'
  // holder found ⇒ recoveree_controls_new_identity is False below.
  let recoveree_controls_new_identity = recoveree_pkh == Some(new_payment_credential)

  // [spec ProposeRecovery 4]: the timelock is FIXED here from the trusted group's
  // recovery_timelock and the tx's own lower bound — never trusted from the datum as
  // given. This is what makes the later veto window un-forgeable: a proposer cannot
  // shorten the window by writing a smaller earliest_execution_slot into the output.
  let current_time = get_lower_bound(tx)
  let expected_earliest_execution_slot = current_time + group.recovery_timelock
  let timelock_correct = earliest_execution_slot == expected_earliest_execution_slot

  // [spec ProposeRecovery 5]: every approver index resolves to a genuinely SIGNED
  // Account-222 holder — collect_signed_approvals crashes (via signed_account_token_name)
  // on any index whose input is unsigned, at a script address, or not a clean single
  // account-token holder. A successful call proves every entry is a real signature.
  let derived_approvals = collect_signed_approvals(
    inputs,
    approver_input_indices,
    account_policy_id,
    extra_signatories,
  )

  // [spec ProposeRecovery 5b]: approvals must be genuine quorum members, distinct, and
  // exclude the lost member's own token (self-vouch). At least 1 required; the M-of-N
  // threshold itself is checked at Execute (async approvals allowed).
  let approvals_valid_members = approvals_are_registry_members(
    derived_approvals,
    group.member_token_names,
  )
  let approvals_distinct = approvals_are_distinct(derived_approvals)
  let target_not_self_vouching = !list.any(
    derived_approvals,
    fn(a) { a == target_token },
  )
  let at_least_one_approval = list.length(derived_approvals) >= 1

  // [spec ProposeRecovery 6]: exactly 1 token minted under own policy, named N'
  let minted_tokens = assets.tokens(mint, own_policy_id)
  let exact_mint = dict.get(minted_tokens, new_member_tokenname) == Some(1) && dict.size(
    minted_tokens,
  ) == 1

  // [spec ProposeRecovery 7]: the request output's datum must equal EXACTLY the
  // values validated above — group_reference_tokenname links to the ACTUAL group
  // input (not an arbitrary caller-supplied value), and approvals equals EXACTLY
  // the derived signed-approval set (a caller cannot claim approvals beyond what
  // was actually signature-verified above).
  let datum_correct =
    request_datum == RecoveryRequest {
      group_reference_tokenname: find_group_token_name(group_input),
      target_token,
      new_member_tokenname,
      new_payment_credential,
      earliest_execution_slot,
      approvals: derived_approvals,
    }

  and {
    target_in_registry?,
    new_not_member?,
    recoveree_controls_new_identity?,
    timelock_correct?,
    approvals_valid_members?,
    approvals_distinct?,
    target_not_self_vouching?,
    at_least_one_approval?,
    datum_correct?,
    exact_mint?,
    (request_output.address.payment_credential == Script(own_policy_id))?,
    // [spec ProposeRecovery 7]: exact token check — output holds EXACTLY {N': 1}
    (dict.to_pairs(assets.tokens(request_output.value, own_policy_id)) == [
      Pair(new_member_tokenname, 1),
    ])?,
    // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
    only_allowed_policies(request_output.value, [ada_policy_id, own_policy_id])?,
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
  let Transaction { inputs, outputs, .. } = tx

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

  // [spec DistributeRound 6c / D3]: PRO-RATA pot = contribution_fee × cached active_member_count
  // (O(1), replaces the O(N²) count_active_members fold). C4 anti-skim is preserved by two pins:
  //   (1) spent_set_complete — the spent treasury set size == active_member_count, and
  //   (2) group_link_ok (per-input) — every spent treasury belongs to THIS group.
  // The group has exactly active_member_count TreasuryState members, so spending that many
  // distinct, this-group TreasuryState treasuries is necessarily ALL of them — a healthy member
  // cannot be excluded, and a foreign-group treasury cannot pad the count.
  let active_members = group.active_member_count
  let total_payout = active_members * group.contribution_fee
  let spent_set_complete = list.length(treasury_input_indices) == active_members

  let is_pull = group.payout_mode == Pull
  // [spec DistributeRound 7a / D2]: the last round of EVERY cycle (generalising the old
  // single-cycle is_last_round) suppresses the ICS transition, so a member drained to the
  // reserve at a cycle boundary stays TreasuryState and can mature/free-exit (D4) — preserving
  // the ROSCA "complete your cycle, then leave clean" path across unlimited cycles. Mid-cycle
  // drains still transition to DefaultState (grace → recover or TerminateDefault).
  let is_cycle_boundary = ( round_number + 1 ) % group.num_rounds == 0
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

        // [security C4 / D3]: the spent treasury must belong to THIS group. count_active_members
        // used to provide this implicitly (by iterating this group's registry); with the cached
        // count we assert it per input so foreign-group treasuries cannot pad the spent set.
        let group_link_ok = group_reference_tokenname == expected_group_token_name

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

        // [spec DistributeRound 7a / D2]: ICS transition when spendable balance drops below
        // contribution_fee, EXCEPT at a cycle boundary (last round of any cycle) — there the
        // member stays TreasuryState so they can mature/free-exit (D4). See is_cycle_boundary.
        let transition_to_ics =
          output_bal < group.contribution_fee && !is_cycle_boundary

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
          group_link_ok?,
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

  // [D3]: group output decrements active_member_count by exactly the number of members that
  // transitioned to DefaultState (ICS) this round. The pot above used the PRE-decrement count
  // (correct — every member who contributed this round is counted, including any going to ICS).
  let ics_count = count_default_outputs(treasury_output_indices, outputs)
  let active_count_correct =
    updated_group.active_member_count == group.active_member_count - ics_count

  and {
    borrower_present?,
    spent_set_complete?,
    group_round_incremented?,
    group_output_valid?,
    active_count_correct?,
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
        rounds_paid,
        ..
      }
    = datum

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

  // [spec ExitGroup D4]: exit branch is rounds_paid-anchored (continuous model — no wall-clock
  // maturity, since a group cycles indefinitely):
  //   pre-start (!is_started) or inactive                          → free exit, token burned
  //   completed a whole cycle (rounds_paid > 0 && % num_rounds==0)  → free exit, token burned
  //   otherwise (mid-cycle, active, started)                       → penalty exit, PenaltyState
  // The is_started guard short-circuits before the modulo so pre-start (num_rounds == 0) never /0.
  let completed_full_cycle =
    group.is_started && rounds_paid > 0 && rounds_paid % group.num_rounds == 0
  let is_early_exit = group.is_active && group.is_started && !completed_full_cycle

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

// ─── Spend: ApproveRecovery ──────────────────────────────────────────────────

// validate_approve_recovery
// ─────────────────────────────────────────────────────────────────────────────
// Appends one more signed member approval to a pending RecoveryRequest. The
// request UTxO is spent and re-created with `approvals ++ [new_approval]`.
// Only the `approvals` field changes; every other field of the RecoveryRequest
// datum is frozen. The treasury-side token N' is preserved in the output.
//
// [spec ApproveRecovery 1]: own input (at request_input_index) == utxo; datum is RecoveryRequest
// [spec ApproveRecovery 2]: group reference input at group_ref_input_index at Script(group_policy);
//                           request's group_reference_tokenname links to this group
// [spec ApproveRecovery 3]: new approver is a registry member, not already in approvals, != target_token
// [spec ApproveRecovery 4]: output datum == input datum with ONLY approvals extended by [new_approval]
// [spec ApproveRecovery 5]: output at treasury script; holds exactly {N': 1} + only ADA; no mint under own policy
pub fn validate_approve_recovery(
  own_policy_id: PolicyId,
  account_policy_id: PolicyId,
  trusted_group_policy: PolicyId,
  group_ref_input_index: Int,
  request_input_index: Int,
  request_output_index: Int,
  approver_input_index: Int,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction {
    inputs,
    reference_inputs,
    outputs,
    mint,
    extra_signatories,
    ..
  } = tx

  // [spec ApproveRecovery 1]: self-reference — request_input_index must resolve to own UTxO
  expect Some(request_input) = list.at(inputs, request_input_index)
  expect request_input.output_reference == utxo
  expect InlineDatum(request_datum_data) = request_input.output.datum
  expect request_datum: TreasuryDatum = request_datum_data
  expect RecoveryRequest {
    group_reference_tokenname,
    target_token,
    new_member_tokenname,
    new_payment_credential,
    earliest_execution_slot,
    approvals: existing_approvals,
  } = request_datum

  // [spec ApproveRecovery 2]: group at Script(trusted_group_policy) as a REFERENCE input
  // (ApproveRecovery does not modify the group — it only reads the registry)
  expect Some(group_input) = list.at(reference_inputs, group_ref_input_index)
  expect
    group_input.output.address.payment_credential == Script(trusted_group_policy)
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data

  // [spec ApproveRecovery 2b]: request's group_reference_tokenname links to this group
  let group_link_valid =
    group_reference_tokenname == find_group_token_name(group_input)

  // [spec ApproveRecovery 3]: new approver via signed_account_token_name — must be at
  // a VK address whose PKH signed, and hold exactly 1 account token. Crashes on
  // unsigned/script-address/multi-token inputs (fail-fast, mirrors ProposeRecovery).
  let new_approval =
    signed_account_token_name(
      inputs,
      approver_input_index,
      account_policy_id,
      extra_signatories,
    )

  // [spec ApproveRecovery 3a]: approver must be a real registry member
  let approver_is_member =
    approvals_are_registry_members([new_approval], group.member_token_names)

  // [spec ApproveRecovery 3b]: approver must NOT already appear in existing_approvals
  let approver_not_duplicate = !list.has(existing_approvals, new_approval)

  // [spec ApproveRecovery 3c]: approver must NOT be the target (no self-vouch)
  let approver_not_target = new_approval != target_token

  // [spec ApproveRecovery 4]: output datum == input datum with ONLY approvals extended.
  // Expressed as a full record reconstruction so any additional future field cannot
  // silently drift — the compiler will require every field to be explicitly specified.
  let updated_approvals = list.concat(existing_approvals, [new_approval])
  expect Some(request_output) = list.at(outputs, request_output_index)
  expect InlineDatum(output_datum_data) = request_output.datum
  expect output_datum: TreasuryDatum = output_datum_data
  let datum_correct =
    output_datum == RecoveryRequest {
      group_reference_tokenname,
      target_token,
      new_member_tokenname,
      new_payment_credential,
      earliest_execution_slot,
      approvals: updated_approvals,
    }

  // [spec ApproveRecovery 5a]: output at the treasury script address
  let output_at_script =
    request_output.address.payment_credential == Script(own_policy_id)

  // [spec ApproveRecovery 5b]: output holds EXACTLY {N': 1} under own policy — no skim,
  // no merge of a second token under this policy (exact token check).
  let token_preserved =
    dict.to_pairs(assets.tokens(request_output.value, own_policy_id)) == [
      Pair(new_member_tokenname, 1),
    ]

  // [spec ApproveRecovery 5c]: output holds only ADA + own policy — prevents accumulation
  let clean_output_value =
    only_allowed_policies(request_output.value, [ada_policy_id, own_policy_id])

  // [spec ApproveRecovery 5d]: no mint under own policy — ApproveRecovery neither mints
  // nor burns; the N' token that authenticates the request persists untouched
  let no_own_mint = dict.size(assets.tokens(mint, own_policy_id)) == 0

  and {
    group_link_valid?,
    approver_is_member?,
    approver_not_duplicate?,
    approver_not_target?,
    datum_correct?,
    output_at_script?,
    token_preserved?,
    clean_output_value?,
    no_own_mint?,
  }
}

// ─── Spend: CancelRecovery ───────────────────────────────────────────────────

// validate_cancel_recovery
// ─────────────────────────────────────────────────────────────────────────────
// Destroys a pending RecoveryRequest and burns its authenticating token N'.
// This is the VETO — the anti-theft escape that proves recovery ≠ theft.
//
// Authorization: EITHER path suffices (no timelock gate on either).
//   (a) VETO by the real holder: some spending input holds the `target_token`
//       under account_policy at a VK address whose PKH signed — proving the
//       token is NOT lost. No extra preconditions: path (a) is available at ANY
//       time, even right after ProposeRecovery, even with a full approvals set.
//   (b) WITHDRAWAL by a proposer/approver: some spending input holds an account
//       token whose name appears in the request's `approvals` list, at a VK
//       address whose PKH signed — a member who vouched withdraws their support.
//
// Veto completeness guarantee: path (a) relies ONLY on `signed_account_token_name`
// finding an input with target_token + a signed PKH. There is no timelock check,
// no quorum requirement, no approval-set precondition. A malicious quorum proposing
// against a token that is NOT lost is defeated by the genuine holder presenting and
// signing that token in the cancellation tx — nothing else required.
//
// The spend handler confirms that the burn in tx.mint matches the request's own
// `new_member_tokenname` (N'). The mint handler (CancelRecovery branch in
// treasury-validator.ak) independently validates that exactly {N': -1} is burned
// and nothing else minted under own policy, creating a bidirectional spend↔mint
// cross-check: neither can be satisfied without the other confirming the same name.
//
// NOTE: self-reference check (own UTxO at request_input_index == utxo) is enforced
// at the entry point before this function is called.
//
// [spec CancelRecovery 1]: datum is RecoveryRequest; destructure target_token, N', approvals
// [spec CancelRecovery 2a]: path (a) — some input holds target_token under account_policy
//                           at a VK address whose PKH ∈ extra_signatories
// [spec CancelRecovery 2b]: path (b) — some input holds an account token whose name is in
//                           approvals, at a VK address whose PKH ∈ extra_signatories
// [spec CancelRecovery 3]: NO timelock gate — veto valid at any time
// [spec CancelRecovery 4]: N' (new_member_tokenname) is burned (qty −1) under own policy,
//                          confirmed by the spend handler cross-checking the mint value;
//                          exact-one-burn enforced in the mint handler
pub fn validate_cancel_recovery(
  own_policy_id: PolicyId,
  account_policy_id: PolicyId,
  request_input_index: Int,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, mint, extra_signatories, .. } = tx

  // [spec CancelRecovery 1]: self-reference confirmed at entry point; extract datum.
  // Destructure only what we need — target_token, N', approvals.
  expect Some(request_input) = list.at(inputs, request_input_index)
  expect request_input.output_reference == utxo
  expect InlineDatum(request_datum_data) = request_input.output.datum
  expect request_datum: TreasuryDatum = request_datum_data
  expect RecoveryRequest {
    target_token,
    new_member_tokenname,
    approvals,
    ..
  } = request_datum

  // [spec CancelRecovery 4]: spend↔mint cross-check — the burn must be EXACTLY
  // {N': -1} under own policy, nothing else minted/burned. This is the bidirectional
  // pin: the spend handler confirms the name matches the request's datum N' AND that
  // no extra tokens are minted/burned under own policy. The mint handler independently
  // enforces the same exact-one-burn shape, so both must agree.
  let n_prime_burned =
    dict.to_pairs(assets.tokens(mint, own_policy_id)) == [
      Pair(new_member_tokenname, -1),
    ]

  // [spec CancelRecovery 2a/2b]: EITHER the real holder of target_token signs, OR a
  // member from the approvals set signs. We scan tx.inputs for ANY input that satisfies
  // one of the two paths — no dedicated input index (avoiding index-as-auth vulnerability).
  //
  // Path (a): input holds exactly 1 of target_token under account_policy_id at a VK
  //           address whose PKH is in extra_signatories. Uses the same shape as
  //           signed_account_token_name but as a scan, not a crash (we try path (b) next).
  //
  // Path (b): input holds exactly 1 of any account token whose name is in approvals,
  //           at a VK address whose PKH is in extra_signatories.
  let authorized =
    list.any(
      inputs,
      fn(inp) {
        when inp.output.address.payment_credential is {
          VerificationKey(pkh) ->
            if list.has(extra_signatories, pkh) {
              // Check path (a): does this input hold exactly target_token?
              let holds_target =
                dict.to_pairs(
                  assets.tokens(inp.output.value, account_policy_id),
                ) == [Pair(target_token, 1)]
              // Check path (b): does this input hold an account token in approvals?
              let holds_approver_token =
                when dict.to_pairs(
                  assets.tokens(inp.output.value, account_policy_id),
                ) is {
                  [Pair(tn, 1)] -> list.has(approvals, tn)
                  _ -> False
                }
              holds_target || holds_approver_token
            } else {
              False
            }
          _ -> False
        }
      },
    )

  // [spec CancelRecovery 3]: NO timelock gate — authorization is sufficient at any time.
  // [spec CancelRecovery 4]: N' burned under own policy, cross-checked against datum.
  and {
    authorized?,
    n_prime_burned?,
  }
}

// ─── Spend: ExecuteRecovery ──────────────────────────────────────────────────

// validate_execute_recovery
// ─────────────────────────────────────────────────────────────────────────────
// Treasury-side half of lost-member identity rotation: completes the recovery
// after the timelock has passed and enough approvals have been gathered. This
// single function validates the WHOLE rotation regardless of which treasury UTxO
// triggered the call — both the RecoveryRequest and the member's treasury UTxO
// carry the ExecuteRecovery spend redeemer. The self-reference check at the
// entry point accepts either UTxO.
//
// Cross-validator coupling:
//   - group is a SPENDING input (RecoverMember updates the registry in the same tx)
//   - this function independently verifies the group output registry swap N→N'
//   - validate_recover_member (group side) pins treasury token presence;
//     this function pins the full economic datum so neither side is sufficient alone
//
// [spec ExecuteRecovery 1]: request input at request_input_index; datum RecoveryRequest;
//                           holds exactly {N': 1} under own policy
// [spec ExecuteRecovery 2]: timelock gate — get_lower_bound(tx) >= earliest_execution_slot
// [spec ExecuteRecovery 3]: group spending input at Script(trusted_group_policy);
//                           request.group_reference_tokenname links to this group;
//                           len(approvals) >= group.recovery_threshold;
//                           group.recovery_threshold <= group.member_count (sanity)
// [spec ExecuteRecovery 4]: member treasury input at member_treasury_input_index;
//                           datum TreasuryState | DefaultState; holds {N: 1} under own policy;
//                           member_reference_tokenname == request.target_token (N)
// [spec ExecuteRecovery 5]: rotated output at member_treasury_output_index;
//                           at Script(own_policy_id); holds exactly {N': 1} under own policy;
//                           value >= member treasury input (ADA conserved);
//                           datum == input state with ONLY member_reference_tokenname→N'
//                           and member_payment_credential→new_payment_credential changed
// [spec ExecuteRecovery 6]: mint == {N: -1} under own policy, nothing else;
//                           burned name == request.target_token
// [spec ExecuteRecovery 7]: group output at group_output_index no longer contains N,
//                           now contains N' (lightweight registry swap coupling)
//
// NOTE: self-reference check (utxo == request_input OR utxo == member_treasury_input)
// is enforced at the entry point before this function is called.
pub fn validate_execute_recovery(
  own_policy_id: PolicyId,
  trusted_group_policy: PolicyId,
  group_ref_input_index: Int,
  group_output_index: Int,
  request_input_index: Int,
  member_treasury_input_index: Int,
  member_treasury_output_index: Int,
  _request_utxo: OutputReference,
  _member_treasury_utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, mint, .. } = tx

  // [spec ExecuteRecovery 1]: request input with RecoveryRequest datum holding N'.
  expect Some(request_input) = list.at(inputs, request_input_index)
  expect InlineDatum(request_datum_data) = request_input.output.datum
  expect request_datum: TreasuryDatum = request_datum_data
  expect RecoveryRequest {
    group_reference_tokenname,
    target_token,
    new_member_tokenname,
    new_payment_credential,
    earliest_execution_slot,
    approvals,
  } = request_datum

  // [spec ExecuteRecovery 1]: request holds exactly {N': 1} under own policy
  let request_holds_n_prime =
    dict.to_pairs(assets.tokens(request_input.output.value, own_policy_id)) == [
      Pair(new_member_tokenname, 1),
    ]

  // [spec ExecuteRecovery 3]: group is a SPENDING input (RecoverMember redeemer modifies it)
  expect Some(group_input) = list.at(inputs, group_ref_input_index)
  // [security C1/C2]: the group input MUST sit at the trusted group script.
  expect
    group_input.output.address.payment_credential == Script(trusted_group_policy)
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data

  // [spec ExecuteRecovery 3]: request's group_reference_tokenname links to this group
  let expected_group_token_name = find_group_token_name(group_input)
  let group_link_valid = group_reference_tokenname == expected_group_token_name

  // [spec ExecuteRecovery 2]: TIMELOCK GATE — lower_bound must be >= earliest_execution_slot.
  // This is what gave the CancelRecovery veto its window.
  let timelock_passed = get_lower_bound(tx) >= earliest_execution_slot

  // [spec ExecuteRecovery 3]: threshold gate — enough approvals and threshold is sane
  let meets_threshold = list.length(approvals) >= group.recovery_threshold
  let threshold_sane = group.recovery_threshold <= group.member_count

  // [spec ExecuteRecovery 4]: member treasury input holds {N: 1} under own policy.
  expect Some(member_treasury_input) = list.at(
    inputs,
    member_treasury_input_index,
  )
  let member_holds_n =
    dict.to_pairs(
      assets.tokens(member_treasury_input.output.value, own_policy_id),
    ) == [Pair(target_token, 1)]

  // [spec ExecuteRecovery 4]: datum is TreasuryState or DefaultState with
  // member_reference_tokenname == target_token (N). Destructure both paths and verify
  // the group link.
  expect InlineDatum(member_datum_data) = member_treasury_input.output.datum
  expect member_datum: TreasuryDatum = member_datum_data

  // Extract member_reference_tokenname and group link for the member treasury,
  // plus carry all economic fields for the rotated output construction.
  let (
    member_ref_tn_ok,
    member_group_link_ok,
    expected_rotated_datum,
  ) =
    when member_datum is {
      TreasuryState {
        member_reference_tokenname: mrt,
        group_reference_tokenname: mgrt,
        assigned_slot,
        rounds_paid,
        member_payment_credential: _old_cred,
        claimable_balance,
      } -> {
        let tn_ok = mrt == target_token
        let gl_ok = mgrt == expected_group_token_name
        // [spec ExecuteRecovery 5]: rotated datum: ONLY member_reference_tokenname→N'
        // and member_payment_credential→new_payment_credential changed; all else preserved.
        let rotated =
          TreasuryState {
            group_reference_tokenname: mgrt,
            member_reference_tokenname: new_member_tokenname,
            assigned_slot,
            rounds_paid,
            member_payment_credential: new_payment_credential,
            claimable_balance,
          }
        (tn_ok, gl_ok, rotated)
      }
      DefaultState {
        member_reference_tokenname: mrt,
        group_reference_tokenname: mgrt,
        grace_expires_at,
        grace_extensions_used,
        rounds_paid,
        assigned_slot,
        member_payment_credential: _old_cred,
        claimable_balance,
      } -> {
        let tn_ok = mrt == target_token
        let gl_ok = mgrt == expected_group_token_name
        // DefaultState: same rotation — member_reference_tokenname→N' and
        // member_payment_credential→new_payment_credential; grace fields preserved.
        let rotated =
          DefaultState {
            group_reference_tokenname: mgrt,
            member_reference_tokenname: new_member_tokenname,
            grace_expires_at,
            grace_extensions_used,
            rounds_paid,
            assigned_slot,
            member_payment_credential: new_payment_credential,
            claimable_balance,
          }
        (tn_ok, gl_ok, rotated)
      }
      // PenaltyState and RecoveryRequest are not valid lost-member positions.
      _ -> fail @"member treasury must be TreasuryState or DefaultState"
    }

  // [spec ExecuteRecovery 5]: rotated output at member_treasury_output_index.
  expect Some(rotated_output) = list.at(outputs, member_treasury_output_index)
  expect InlineDatum(rotated_datum_data) = rotated_output.datum
  expect rotated_datum: TreasuryDatum = rotated_datum_data

  // [spec ExecuteRecovery 5]: output at the treasury script address
  let output_at_script =
    rotated_output.address.payment_credential == Script(own_policy_id)

  // [spec ExecuteRecovery 5]: output holds exactly {N': 1} under own policy — N' is
  // relocated from the request UTxO (not freshly minted); net mint is only {N: -1}.
  let output_holds_n_prime =
    dict.to_pairs(assets.tokens(rotated_output.value, own_policy_id)) == [
      Pair(new_member_tokenname, 1),
    ]

  // [spec ExecuteRecovery 5]: the rotated output's total lovelace >= input lovelace
  // (ADA must not decrease — for an ADA-denominated group this also pins the
  // contribution balance, since the contribution asset IS the lovelace).
  let value_conserved =
    assets.lovelace_of(rotated_output.value) >= assets.lovelace_of(
      member_treasury_input.output.value,
    )

  // [security]: the rotated output may hold ONLY ADA + own policy + the group's
  // contribution asset — no foreign tokens can be smuggled in, and (paired with the
  // contribution-conservation check below) no contribution tokens can be routed out.
  let clean_output_value =
    only_allowed_policies(
      rotated_output.value,
      [ada_policy_id, own_policy_id, group.contribution_fee_policyid],
    )

  // [security]: for a NATIVE-TOKEN group the contribution balance is independent of
  // lovelace, so value_conserved alone does NOT stop a drain of the member's
  // contribution tokens. Pin the contributable balance exactly — rotation must not
  // change the recovered member's economic position. For an ADA group this is a no-op
  // beyond value_conserved (the lovelace floor already covers it).
  let contribution_conserved =
    contributable_in(
      rotated_output.value,
      group.contribution_fee_policyid,
      group.contribution_fee_assetname,
    ) == contributable_in(
      member_treasury_input.output.value,
      group.contribution_fee_policyid,
      group.contribution_fee_assetname,
    )

  // [spec ExecuteRecovery 5]: datum exactly matches the constructed rotated datum
  // (two-field record update: member_reference_tokenname, member_payment_credential).
  let datum_correct = rotated_datum == expected_rotated_datum

  // [spec ExecuteRecovery 6]: mint == {N: -1} under own policy, nothing else.
  // N' is RELOCATED (already minted by ProposeRecovery; goes from request to rotated output),
  // so the only net own-policy mint event here is the burn of the old identity N.
  let minted_tokens = assets.tokens(mint, own_policy_id)
  let exact_burn =
    dict.to_pairs(minted_tokens) == [Pair(target_token, -1)]

  // [spec ExecuteRecovery 7]: group output shows N→N' swap — lightweight coupling.
  // RecoverMember enforces the full registry edit; we independently verify N is gone
  // and N' is present so ExecuteRecovery is self-sufficient.
  expect Some(group_output) = list.at(outputs, group_output_index)
  // [security]: the group output must sit at the SAME script address as the group input —
  // token presence alone does not prove the registry edit landed back at the group script.
  // Mirrors validate_terminate_default; keeps the treasury side self-sufficient rather than
  // relying solely on RecoverMember to place the group output correctly.
  expect group_output.address == group_input.output.address
  expect InlineDatum(group_output_datum_data) = group_output.datum
  expect GroupCip68Datum { extra: updated_group, .. } = group_output_datum_data
  let registry_n_removed = !list.any(
    updated_group.member_token_names,
    fn(n) { n == target_token },
  )
  let registry_n_prime_added = list.any(
    updated_group.member_token_names,
    fn(n) { n == new_member_tokenname },
  )

  and {
    request_holds_n_prime?,
    group_link_valid?,
    timelock_passed?,
    meets_threshold?,
    threshold_sane?,
    member_holds_n?,
    member_ref_tn_ok?,
    member_group_link_ok?,
    output_at_script?,
    output_holds_n_prime?,
    value_conserved?,
    clean_output_value?,
    contribution_conserved?,
    datum_correct?,
    exact_burn?,
    registry_n_removed?,
    registry_n_prime_added?,
  }
}

// ─── Mint: CancelRecovery (burn N') ──────────────────────────────────────────

// validate_cancel_recovery_mint
// ─────────────────────────────────────────────────────────────────────────────
// Validates the CancelRecovery mint/burn: exactly one token is burned under own
// policy (qty = -1) and no other tokens are minted or burned under own policy.
// The spend handler confirms the burned token name matches this request's N'
// (cross-check). This is the symmetric partner of validate_claim_penalty_mint —
// same exact-one-burn shape, pinned to the N' name (done in the spend check above).
//
// [spec CancelRecovery mint 1]: exactly one token under own policy burned (qty = -1),
//                               no other mints/burns under own policy.
pub fn validate_cancel_recovery_mint(own_policy_id: PolicyId, mint: Value) -> Bool {
  let minted_tokens = assets.tokens(mint, own_policy_id)
  // Exactly one entry, with quantity -1 (mirrors validate_claim_penalty_mint shape).
  expect [Pair(_, qty)] = dict.to_pairs(minted_tokens)
  (qty == -1)?
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
    RecoveryRequest { .. } -> fail @"RecoveryRequest cannot receive contributions"
  }

  // [spec Contribute 2]: member auth
  let member_authorized = member_has_user_token(
    inputs,
    member_input_index,
    member_reference_tokenname,
    account_policy_id,
  )

  // The group supplies the contribution asset + fee and links to this treasury. During a
  // TOP-UP (TreasuryState) the group is a read-only REFERENCE input. During a RECOVERY
  // (DefaultState -> TreasuryState) the group is SPENT with the Recover redeemer (it must bump
  // active_member_count, which lives in the group datum), so it appears in `inputs` instead of
  // `reference_inputs`. Read it from the correct list. The Recover handler independently
  // verifies the active+1 transition; here we only need the asset identity + link.
  let is_recovery = when datum is {
    DefaultState { .. } -> True
    _ -> False
  }
  let group_utxo =
    if is_recovery {
      expect Some(gi) = list.at(inputs, group_ref_input_index)
      gi
    } else {
      expect Some(gi) = list.at(reference_inputs, group_ref_input_index)
      gi
    }
  // [security C1]: the group must sit at the trusted group script.
  expect
    group_utxo.output.address.payment_credential == Script(trusted_group_policy)
  expect InlineDatum(group_datum_data) = group_utxo.output.datum
  expect GroupCip68Datum { extra: group, .. } = group_datum_data
  let group_link_valid = datum_group_tokenname == find_group_token_name(group_utxo)

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

    RecoveryRequest { .. } -> fail @"RecoveryRequest cannot receive contributions"
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
