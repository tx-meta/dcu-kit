use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address.{Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use dcu/cip68
use dcu/group.{GroupDatum}

/// Contribution struct for Treasury Datum
pub type Contribution {
  claimable_at: Int,
  claimable_amount: Int,
}

/// Treasury Validator Datum (Sum Type)
pub type TreasuryDatum {
  TreasuryState {
    group_reference_tokenname: AssetName,
    member_reference_tokenname: AssetName,
    membership_start: Int,
    assigned_slot: Int,
    contribution_list: List<Contribution>,
    // payment key hash of the member's wallet; used in DistributePayout
    // to route the payout to the correct borrower address
    member_payment_credential: ByteArray,
  }
  PenaltyState {
    group_reference_tokenname: AssetName,
    member_reference_tokenname: AssetName,
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
  TerminateGroup {
    // group input (reference or spending) to derive the group policy_id for admin token check.
    // TerminateGroup does NOT spend or update the group UTxO — member_count was already
    // decremented at ExitGroup time. This index is only needed to read the group's script
    // credential so the admin (222) token name can be validated.
    group_input_index: Int,
    // admin input holding the group (222) user token
    admin_input_index: Int,
  }
  DistributePayout {
    group_ref_input_index: Int,
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
  MemberWithdraw {
    group_ref_input_index: Int,
    member_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
    withdrawal_amount: Int,
  }
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

// claimable_sum
// Returns the sum of all `claimable_amount`s where `claimable_at <= current_time`.
pub fn claimable_sum(
  contributions: List<Contribution>,
  current_time: Int,
) -> Int {
  list.foldl(
    contributions,
    0,
    fn(c, acc) {
      if c.claimable_at <= current_time {
        acc + c.claimable_amount
      } else {
        acc
      }
    },
  )
}

// remove_claimable
// Returns contributions where `claimable_at > current_time` (the "paid" entries removed).
pub fn remove_claimable(
  contributions: List<Contribution>,
  current_time: Int,
) -> List<Contribution> {
  list.filter(contributions, fn(c) { c.claimable_at > current_time })
}

// validate_contribution_list_at_join
// Verifies the pre-populated contribution list is consistent with the group schedule:
//   length == num_intervals, each entry claimable_at = start_time + (i+1)*interval_length,
//   each claimable_amount == contribution_fee.
fn validate_contribution_list_at_join(
  contributions: List<Contribution>,
  start_time: Int,
  interval_length: Int,
  contribution_fee: Int,
  num_intervals: Int,
) -> Bool {
  let length_valid = list.length(contributions) == num_intervals
  let entries_valid =
    check_entries(
      contributions,
      start_time,
      interval_length,
      contribution_fee,
      0,
    )
  and {
    length_valid?,
    entries_valid?,
  }
}

fn check_entries(
  contributions: List<Contribution>,
  start_time: Int,
  interval_length: Int,
  contribution_fee: Int,
  index: Int,
) -> Bool {
  when contributions is {
    [] -> True
    [c, ..rest] ->
      c.claimable_at == start_time + ( index + 1 ) * interval_length && c.claimable_amount == contribution_fee && check_entries(
        rest,
        start_time,
        interval_length,
        contribution_fee,
        index + 1,
      )
  }
}

// compute_current_slot
// current_slot = (current_time - start_time) / interval_length % num_intervals
fn compute_current_slot(
  current_time: Int,
  start_time: Int,
  interval_length: Int,
  num_intervals: Int,
) -> Int {
  ( current_time - start_time ) / interval_length % num_intervals
}

// get_lower_bound
// Extracts the Finite lower bound from a transaction's validity_range.
// Fails if the lower bound is not a Finite value (required for time-based checks).
fn get_lower_bound(tx: Transaction) -> Int {
  expect Finite(t) = tx.validity_range.lower_bound.bound_type
  t
}

// member_has_user_token
// Verifies the input at member_input_index holds exactly 1 token of
// member_reference_tokenname under the account_policy_id.
// This proves the caller owns the Account NFT (user token) registered under
// the DCU account validator — not just any token with a matching name.
//
// NOTE: member_reference_tokenname in TreasuryState IS the full user token name
// (prefix_222 + unique hash), because the SDK derives it from the member's wallet
// UTxO which holds the account user token.
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
// The group UTxO is at a Script address — the script hash is the group policy.
// Uses destructure `[Pair(name, 1)]` to defensively reject multiple-token UTxOs.
fn find_group_token_name(group_input: Input) -> AssetName {
  expect Script(group_policy_id) = group_input.output.address.payment_credential
  expect [Pair(group_token_name, 1)] =
    dict.to_pairs(assets.tokens(group_input.output.value, group_policy_id))
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

// ─── Mint: JoinGroup ──────────────────────────────────────────────────────────

// validate_join_group
// ─────────────────────────────────────────────────────────────────────────────
// [spec JoinGroup 1]: member input at member_input_index must hold the Account NFT
//                     (user token) under account_policy_id — proves identity ownership
// [spec JoinGroup 2]: group UTxO at group_ref_input_index is a spending input
//                     with a valid GroupDatum (group must be updated in same tx)
// [spec JoinGroup 3]: exactly one membership token minted under own policy;
//                     the token name = member_reference_tokenname from treasury datum
// [spec JoinGroup 4]: treasury output at treasury_output_index is at the treasury
//                     script address (Script(own_policy_id))
// [spec JoinGroup 5]: treasury output holds EXACTLY 1 membership token, only ADA +
//                     own policy — prevents unbounded value / token stuffing
// [spec JoinGroup 6]: treasury output datum is TreasuryState consistent with
//                     GroupDatum: group_reference_tokenname links to the group,
//                     assigned_slot == group.member_count (slot assigned sequentially),
//                     contribution_list has num_intervals entries with correct amounts,
//                     member_payment_credential records the member's wallet pkh
// [spec JoinGroup 7]: treasury output ADA ≥ contribution_fee + joining_fee
// [security        ]: member user token must NOT go to any script address —
//                     if trapped in a script, membership control is permanently lost
pub fn validate_join_group(
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
  expect group: GroupDatum = group_datum_data

  // [spec JoinGroup]: group must be active — members cannot join deactivated groups
  let group_active = group.is_active

  // Extract group policy ID for output validation
  expect Script(group_policy_id) = group_input.output.address.payment_credential

  // [spec JoinGroup 4]: treasury output at script address
  expect Some(treasury_output) = list.at(outputs, treasury_output_index)
  expect InlineDatum(treasury_datum_data) = treasury_output.datum
  expect TreasuryState {
    member_reference_tokenname,
    group_reference_tokenname,
    membership_start,
    assigned_slot,
    contribution_list,
    member_payment_credential,
  }: TreasuryDatum = treasury_datum_data

  // [spec JoinGroup]: membership_start must equal the tx lower bound —
  //   records the exact time the member joined; frozen from this point on
  //   via validate_member_withdraw's structural equality check.
  let current_time = get_lower_bound(tx)
  let membership_start_valid = membership_start == current_time

  // [spec JoinGroup 3]: exactly 1 membership token minted under own policy
  let minted_tokens = assets.tokens(mint, own_policy_id)
  let exact_mint =
    dict.get(minted_tokens, member_reference_tokenname) == Some(1) && dict.size(
      minted_tokens,
    ) == 1

  // [spec JoinGroup 6a]: group_reference_tokenname links to the actual group input
  let expected_group_token_name = find_group_token_name(group_input)
  let group_link_valid = group_reference_tokenname == expected_group_token_name

  // [spec JoinGroup 6b]: assigned_slot == group.member_count (sequential slot assignment)
  let slot_valid = assigned_slot == group.member_count

  // [spec JoinGroup 6d]: group output at group_output_index has member_count + 1 —
  //   ensures the Group validator's MemberJoin redeemer atomically updates member_count.
  //   Without this, member_count would stay at 0 forever and every member would
  //   receive assigned_slot = 0, breaking ROSCA rotation.
  expect Some(group_output) = list.at(outputs, group_output_index)
  expect InlineDatum(go_data) = group_output.datum
  expect updated_group: GroupDatum = go_data
  let member_count_incremented =
    updated_group.member_count == group.member_count + 1

  // [spec JoinGroup Minor 9]: group output must be at the group script address and
  //   retain the ref token — prevents substituting a fake group output datum
  let group_output_at_correct_address =
    group_output.address == group_input.output.address
  let group_output_has_ref_token =
    assets.quantity_of(
      group_output.value,
      group_policy_id,
      expected_group_token_name,
    ) == 1

  // [spec JoinGroup 6c]: contribution_list has num_intervals entries with correct schedule
  let list_valid =
    validate_contribution_list_at_join(
      contribution_list,
      group.start_time,
      group.interval_length,
      group.contribution_fee,
      group.num_intervals,
    )

  // [spec JoinGroup 7]: sufficient fees locked — contribution_fee + joining_fee.
  //
  // When both fees are the same asset (e.g. both ADA), two independent `quantity_of >= fee`
  // checks are insufficient: a deposit of max(contribution_fee, joining_fee) would satisfy
  // both while only the larger is actually locked. We detect this case and require the SUM.
  let same_fee_asset =
    group.contribution_fee_policyid == group.joining_fee_policyid && group.contribution_fee_assetname == group.joining_fee_assetname

  let fees_locked =
    if same_fee_asset {
      // Same asset: require the combined amount in a single check
      assets.quantity_of(
        treasury_output.value,
        group.contribution_fee_policyid,
        group.contribution_fee_assetname,
      ) >= group.contribution_fee + group.joining_fee
    } else {
      // Different assets: each is independently satisfied
      assets.quantity_of(
        treasury_output.value,
        group.contribution_fee_policyid,
        group.contribution_fee_assetname,
      ) >= group.contribution_fee && assets.quantity_of(
        treasury_output.value,
        group.joining_fee_policyid,
        group.joining_fee_assetname,
      ) >= group.joining_fee
    }

  // [spec JoinGroup 1]: member input must hold the Account NFT under account_policy_id
  //   Using quantity_of with the specific account policy prevents accepting arbitrary
  //   tokens — only a real Account NFT minted by the DCU account validator passes.
  let member_authorized =
    member_has_user_token(
      inputs,
      member_input_index,
      member_reference_tokenname,
      account_policy_id,
    )

  // [spec JoinGroup 6e]: member_payment_credential must record the member's wallet pkh —
  //   stored at join time so DistributePayout can verify the borrower output destination.
  //   Enforces that the credential is a VerificationKey (wallets only, no scripts).
  expect Some(member_input_utxo) = list.at(inputs, member_input_index)
  expect VerificationKey(member_pkh) =
    member_input_utxo.output.address.payment_credential
  let member_cred_matches = member_payment_credential == member_pkh

  // [security]: Account NFT (member user token) must NOT go to any script address —
  //   if trapped in a script the member permanently loses control of their membership
  let user_token_at_wallet =
    list.all(
      outputs,
      fn(o) {
        // If an output holds the member_reference_tokenname under the account policy,
        // it must be at a wallet (VerificationKey), not a script
        let has_user_token =
          assets.quantity_of(
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
    exact_mint?,
    (treasury_output.address.payment_credential == Script(own_policy_id))?,
    // [spec JoinGroup 5]: exact token check — exactly 1 membership token, prevents token stuffing
    (dict.to_pairs(assets.tokens(treasury_output.value, own_policy_id)) == [
      Pair(member_reference_tokenname, 1),
    ])?,
    // [security]: only ADA + own policy in treasury output — prevents unbounded value accumulation
    (assets.policies(treasury_output.value) == [ada_policy_id, own_policy_id])?,
    group_link_valid?,
    slot_valid?,
    member_count_incremented?,
    group_output_at_correct_address?,
    group_output_has_ref_token?,
    list_valid?,
    fees_locked?,
    member_authorized?,
    member_cred_matches?,
    membership_start_valid?,
    user_token_at_wallet?,
  }
}

// ─── Mint: TerminateGroup / ExitGroup (burn) ──────────────────────────────────

// validate_terminate_group
// ─────────────────────────────────────────────────────────────────────────────
// [spec TerminateGroup 1]: exactly one membership token is burned under this policy.
//   This covers both the PenaltyWithdraw (TerminateGroup redeemer) and
//   the mature ExitGroup (ExitGroup redeemer) burn paths, since both pass
//   the same mint logic — "burn exactly 1 token under own policy."
// [security]: no net minting allowed — prevents a burn-and-remint attack where
//             an attacker burns one token and mints a new one in the same tx.
pub fn validate_terminate_group(own_policy_id: PolicyId, mint: Value) -> Bool {
  let minted_tokens = assets.tokens(mint, own_policy_id)
  // Exactly one entry, with quantity -1
  expect [Pair(_, qty)] = dict.to_pairs(minted_tokens)
  (qty == -1)?
}

// ─── Spend: DistributePayout ──────────────────────────────────────────────────

// validate_distribute_payout
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check (own UTxO is at one of treasury_input_indices) is
//       enforced at the entry point in treasury-validator.ak before this function.
//
// [spec DistributePayout 1]: datum must be TreasuryState — PenaltyState cannot receive payout
// [spec DistributePayout 2]: group reference input at group_ref_input_index
//                            (in tx.reference_inputs) has a valid GroupDatum
// [spec DistributePayout 3]: eligibility — at least one treasury input has
//                            assigned_slot == current_slot (the borrower is present)
// [spec DistributePayout 4]: own corresponding treasury output (matched by index
//                            in the parallel treasury_input/output_indices lists)
//                            returns to the treasury script address with:
//                            • the membership token still locked
//                            • updated datum (claimable_at <= current_time entries removed)
// [spec DistributePayout 5]: borrower output at borrower_output_index is at the
//                            scheduled member's wallet (member_payment_credential)
//                            and receives at least the total claimable across all inputs
// [security]: treasury_input_indices must be strictly ascending to prevent
//             duplicate-index attacks where the same UTxO is listed twice
pub fn validate_distribute_payout(
  own_policy_id: PolicyId,
  group_ref_input_index: Int,
  treasury_input_indices: List<Int>,
  treasury_output_indices: List<Int>,
  borrower_output_index: Int,
  datum: TreasuryDatum,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, reference_inputs, outputs, .. } = tx

  // [spec DistributePayout 1]: datum must be TreasuryState
  expect TreasuryState {
    member_reference_tokenname,
    assigned_slot: _,
    contribution_list,
    ..
  } = datum

  // Get current time from validity range lower bound
  let current_time = get_lower_bound(tx)

  // [spec DistributePayout 2]: group reference input with GroupDatum
  expect Some(group_ref_input) =
    list.at(reference_inputs, group_ref_input_index)
  expect InlineDatum(group_datum_data) = group_ref_input.output.datum
  expect group: GroupDatum = group_datum_data

  // [spec DistributePayout 2 — intentional]: group.is_active is NOT required.
  // Contributions whose claimable_at <= current_time are due regardless of
  // whether the group is still active. Members retain the right to claim
  // already-accrued contributions after group deactivation.
  // Compute current rotation slot
  expect current_time >= group.start_time
  let current_slot =
    compute_current_slot(
      current_time,
      group.start_time,
      group.interval_length,
      group.num_intervals,
    )

  // [security]: both index lists must be strictly ascending —
  //   prevents duplicate-index attacks where the same UTxO or output appears twice.
  //   input dedup prevents the same treasury UTxO being processed twice.
  //   output dedup prevents two treasury UTxOs pointing at the same output, which
  //   would let each validator independently satisfy its ADA balance check against
  //   one shared output and drain excess ADA to the borrower.
  let indices_valid = indices_in_ascending_order(treasury_input_indices)
  let output_indices_valid = indices_in_ascending_order(treasury_output_indices)

  // [spec DistributePayout 5a]: find the borrower's payment credential from the
  //   treasury input whose assigned_slot == current_slot. Stored at join time,
  //   this ensures the payout goes to the scheduled member's wallet.
  expect Some(borrower_cred) =
    list.find_map(
      treasury_input_indices,
      fn(idx) {
        when list.at(inputs, idx) is {
          Some(treasury_input) -> {
            expect InlineDatum(d) = treasury_input.output.datum
            expect td: TreasuryDatum = d
            when td is {
              TreasuryState {
                assigned_slot: slot,
                member_payment_credential: cred,
                ..
              } ->
                if slot == current_slot {
                  Some(cred)
                } else {
                  None
                }
              PenaltyState { .. } -> None
            }
          }
          None -> None
        }
      },
    )

  // [spec DistributePayout 5b]: total claimable across all treasury inputs —
  //   the borrower output must receive at least this amount.
  //   Each UTxO's output enforces its own share via ada_balance_correct below;
  //   this check ensures the aggregate flows to the correct destination.
  let total_claimable =
    list.foldl(
      treasury_input_indices,
      0,
      fn(idx, acc) {
        when list.at(inputs, idx) is {
          Some(treasury_input) -> {
            expect InlineDatum(d) = treasury_input.output.datum
            expect td: TreasuryDatum = d
            when td is {
              TreasuryState { contribution_list: cl, .. } ->
                acc + claimable_sum(cl, current_time)
              PenaltyState { .. } -> acc
            }
          }
          None -> acc
        }
      },
    )

  // [spec DistributePayout 4]: find own corresponding output
  //   Find own position in treasury_input_indices, get matching treasury_output_indices[i]
  expect Some(own_output_index) =
    list.find_map(
      list.zip(treasury_input_indices, treasury_output_indices),
      fn(pair) {
        let (in_idx, out_idx) = pair
        when list.at(inputs, in_idx) is {
          Some(treasury_input) ->
            if treasury_input.output_reference == utxo {
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
  expect TreasuryState { contribution_list: output_contribution_list, .. } =
    output_datum

  // [spec DistributePayout 4a]: updated datum has claimable entries removed
  let expected_remaining = remove_claimable(contribution_list, current_time)
  let datum_updated_correctly = output_contribution_list == expected_remaining

  // [spec DistributePayout 4b]: treasury output retains its membership token at script address
  let output_at_script =
    own_output.address.payment_credential == Script(own_policy_id)
  // [spec DistributePayout 4b]: exact token check — prevents token stuffing / account-merge
  let token_retained =
    dict.to_pairs(assets.tokens(own_output.value, own_policy_id)) == [
      Pair(member_reference_tokenname, 1),
    ]
  // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
  let clean_output_value =
    assets.policies(own_output.value) == [ada_policy_id, own_policy_id]

  // [spec DistributePayout 4c]: treasury output ADA = input ADA - own claimable sum
  //   Prevents the claimable entries from being marked paid without value being released.
  //   Each UTxO's validator enforces its own share; the aggregate payout to the borrower
  //   follows as a consequence across all treasury inputs.
  expect Some(own_input) =
    list.find(inputs, fn(i) { i.output_reference == utxo })
  let own_claimable = claimable_sum(contribution_list, current_time)
  let input_ada = assets.lovelace_of(own_input.output.value)
  let output_ada = assets.lovelace_of(own_output.value)
  let ada_balance_correct = output_ada == input_ada - own_claimable

  // [spec DistributePayout 5]: borrower output is at the scheduled member's wallet
  //   and receives at least the total claimable across all treasury inputs
  expect Some(borrower_output) = list.at(outputs, borrower_output_index)
  let borrower_at_correct_wallet =
    borrower_output.address.payment_credential == VerificationKey(borrower_cred)
  let borrower_receives_total =
    assets.lovelace_of(borrower_output.value) >= total_claimable

  and {
    indices_valid?,
    output_indices_valid?,
    datum_updated_correctly?,
    output_at_script?,
    token_retained?,
    clean_output_value?,
    ada_balance_correct?,
    borrower_at_correct_wallet?,
    borrower_receives_total?,
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
//                     (proves the caller owns the membership)
// [spec ExitGroup 3]: group spending input at group_ref_input_index has GroupDatum
//                     (group is being updated to decrement member count in same tx)
// [spec ExitGroup 4a]: Penalty path (group active AND within rotation period):
//                      penalty output at penalty_output_index has PenaltyState datum,
//                      retains the membership token, contains ≥ penalty_fee of the
//                      penalty asset, AND preserves all treasury input ADA —
//                      prevents the member from draining locked contributions during exit
// [spec ExitGroup 4b]: Mature/inactive path (group inactive OR past rotation end):
//                      membership token is burned in this transaction
pub fn validate_exit_group(
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
  expect TreasuryState { member_reference_tokenname, .. } = datum

  // Get current time
  let current_time = get_lower_bound(tx)

  // [spec ExitGroup 3]: group spending input with GroupDatum
  expect Some(group_input) = list.at(inputs, group_ref_input_index)
  expect InlineDatum(group_datum_data) = group_input.output.datum
  expect group: GroupDatum = group_datum_data

  // Extract group policy ID for output validation (Minor 9)
  expect Script(group_policy_id) = group_input.output.address.payment_credential
  let expected_group_token_name = find_group_token_name(group_input)

  // [spec ExitGroup 2]: member input holds the Account NFT under account_policy_id
  let member_authorized =
    member_has_user_token(
      inputs,
      member_input_index,
      member_reference_tokenname,
      account_policy_id,
    )

  // Determine exit branch: early exit requires penalty; inactive/mature exit burns token
  let maturity_time =
    group.start_time + group.num_intervals * group.interval_length
  let is_early_exit = group.is_active && current_time < maturity_time

  // [spec ExitGroup 3]: group output — member_count decrements on BOTH paths.
  //   penalty path: slot freed immediately so rotation continues unblocked
  //   mature/inactive path: token burned, slot freed
  //   TerminateGroup handles penalty ADA independently; it does not touch group state.
  expect Some(group_output_utxo) = list.at(outputs, group_output_index)
  expect InlineDatum(go_data) = group_output_utxo.datum
  expect updated_group: GroupDatum = go_data

  // [spec ExitGroup Minor 9]: group output must be at the group script address and
  //   retain the ref token — prevents substituting a fake group output datum
  let group_output_at_correct_address =
    group_output_utxo.address == group_input.output.address
  let group_output_has_ref_token =
    assets.quantity_of(
      group_output_utxo.value,
      group_policy_id,
      expected_group_token_name,
    ) == 1

  if is_early_exit {
    // [spec ExitGroup 4a]: penalty output required
    expect Some(penalty_output) = list.at(outputs, penalty_output_index)
    expect InlineDatum(penalty_datum_data) = penalty_output.datum
    expect PenaltyState { member_reference_tokenname: penalty_member_tn, .. }: TreasuryDatum =
      penalty_datum_data

    // [spec ExitGroup 4a]: penalty output retains the membership token (exact check)
    let token_in_penalty =
      dict.to_pairs(assets.tokens(penalty_output.value, own_policy_id)) == [
        Pair(member_reference_tokenname, 1),
      ]

    // Penalty output is at the treasury script address
    let penalty_at_script =
      penalty_output.address.payment_credential == Script(own_policy_id)

    // Penalty output contains ≥ penalty_fee of the penalty asset
    let penalty_fee_locked =
      assets.quantity_of(
        penalty_output.value,
        group.penalty_fee_policyid,
        group.penalty_fee_assetname,
      ) >= group.penalty_fee

    // Penalty datum references the same member token name
    let penalty_datum_matches = penalty_member_tn == member_reference_tokenname

    // [security]: penalty output holds only ADA, own policy (membership token), and the
    // group's penalty fee policy — prevents unbounded value accumulation while supporting
    // native token penalty fees set at group creation.
    // ada_policy_id and own_policy_id are always present (every UTxO has ADA; membership
    // token is enforced by token_in_penalty), so they must be in the whitelist.
    let clean_penalty_value =
      list.all(
        assets.policies(penalty_output.value),
        fn(p) {
          p == ada_policy_id || p == own_policy_id || p == group.penalty_fee_policyid
        },
      )

    // [spec ExitGroup 3]: penalty path — member exits immediately, freeing the slot.
    //   member_count decrements now; TerminateGroup later only burns the penalty token
    //   and releases ADA to the admin — it does not touch group state.
    //   This prevents one member's early exit from stalling the group's rotation.
    let group_count_decremented =
      updated_group.member_count == group.member_count - 1

    and {
      member_authorized?,
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
    // [spec ExitGroup 4b]: mature/inactive exit — exactly 1 membership token burned,
    //   no other tokens minted under own policy (consistent with validate_terminate_group)
    let token_burned =
      dict.to_pairs(assets.tokens(mint, own_policy_id)) == [
        Pair(member_reference_tokenname, -1),
      ]

    // [spec ExitGroup 3]: mature exit — member fully exits, member_count decrements
    let group_count_decremented =
      updated_group.member_count == group.member_count - 1

    and {
      member_authorized?,
      token_burned?,
      group_count_decremented?,
      group_output_at_correct_address?,
      group_output_has_ref_token?,
    }
  }
}

// ─── Spend: MemberWithdraw ────────────────────────────────────────────────────

// validate_member_withdraw
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check (own UTxO at treasury_input_index) is enforced at
//       the entry point before this function is called.
//
// [spec MemberWithdraw 1]: datum must be TreasuryState
// [spec MemberWithdraw 2]: member input at member_input_index holds the user token
//                          (authorization — caller owns the membership)
// [spec MemberWithdraw 3]: group reference input at group_ref_input_index
//                          (in tx.reference_inputs) has a valid GroupDatum
// [spec MemberWithdraw 4]: withdrawal_amount ≤ sum of claimable contributions
//                          (claimable_at <= current_time) — linear vesting check
// [spec MemberWithdraw 5]: treasury output at treasury_output_index returns to
//                          script address with:
//                          • membership token retained
//                          • updated datum (claimable entries removed, all other fields frozen)
//                          • only ADA + own policy (no unbounded value)
// [spec MemberWithdraw 6]: ADA balance in output = input balance - withdrawal_amount
// [security]: output datum uses structural equality — only contribution_list changes;
//             assigned_slot, group_reference_tokenname, membership_start, and
//             member_payment_credential are all frozen to prevent slot hijacking
pub fn validate_member_withdraw(
  own_policy_id: PolicyId,
  account_policy_id: PolicyId,
  group_ref_input_index: Int,
  member_input_index: Int,
  treasury_output_index: Int,
  withdrawal_amount: Int,
  datum: TreasuryDatum,
  utxo: OutputReference,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, reference_inputs, outputs, mint, .. } = tx

  // [spec MemberWithdraw 1]: datum must be TreasuryState
  // Extract all fields for structural equality check on the output datum
  expect TreasuryState {
    group_reference_tokenname,
    member_reference_tokenname,
    membership_start,
    assigned_slot,
    contribution_list,
    member_payment_credential,
  } = datum

  // Get current time
  let current_time = get_lower_bound(tx)

  // [spec MemberWithdraw 3]: group reference input with valid GroupDatum
  expect Some(group_ref_input) =
    list.at(reference_inputs, group_ref_input_index)
  expect InlineDatum(group_datum_data) = group_ref_input.output.datum
  expect group: GroupDatum = group_datum_data

  // [spec MemberWithdraw 2]: member input holds the Account NFT under account_policy_id
  let member_authorized =
    member_has_user_token(
      inputs,
      member_input_index,
      member_reference_tokenname,
      account_policy_id,
    )

  if !group.is_active {
    // [spec MemberWithdraw inactive]: group is inactive — member exits with full withdrawal.
    //   The membership token is burned; the UTxO is fully consumed.
    //   No treasury output is required — ADA returns to wherever the tx directs it.
    let token_burned =
      dict.to_pairs(assets.tokens(mint, own_policy_id)) == [
        Pair(member_reference_tokenname, -1),
      ]

    and {
      member_authorized?,
      token_burned?,
    }
  } else {
    // Get own treasury input value for ADA balance check
    expect Some(own_input) =
      list.find(inputs, fn(i) { i.output_reference == utxo })
    let input_ada = assets.lovelace_of(own_input.output.value)

    // [spec MemberWithdraw 4]: withdrawal_amount ≤ total claimable amount — member may
    // claim less than the full claimable sum (e.g. to satisfy min-ADA on the output UTxO).
    // Any unclaimed ADA remains in the UTxO and is recovered on ExitGroup.
    let total_claimable = claimable_sum(contribution_list, current_time)
    let withdrawal_valid =
      withdrawal_amount <= total_claimable && withdrawal_amount > 0

    // [spec MemberWithdraw 5]: treasury output with updated datum
    expect Some(treasury_output) = list.at(outputs, treasury_output_index)
    expect InlineDatum(output_datum_data) = treasury_output.datum
    expect output_datum: TreasuryDatum = output_datum_data

    // [security]: structural equality — only contribution_list changes.
    //   assigned_slot, group_reference_tokenname, membership_start, and
    //   member_payment_credential are all frozen. Without this check, a member
    //   could hijack another member's slot by mutating assigned_slot during withdrawal.
    let expected_remaining = remove_claimable(contribution_list, current_time)
    let expected_output_datum =
      TreasuryState {
        group_reference_tokenname,
        member_reference_tokenname,
        membership_start,
        assigned_slot,
        contribution_list: expected_remaining,
        member_payment_credential,
      }
    let datum_frozen = output_datum == expected_output_datum

    // [spec MemberWithdraw 5]: output at treasury script address
    let output_at_script =
      treasury_output.address.payment_credential == Script(own_policy_id)

    // [spec MemberWithdraw 5]: membership token retained (exact token check)
    let token_retained =
      dict.to_pairs(assets.tokens(treasury_output.value, own_policy_id)) == [
        Pair(member_reference_tokenname, 1),
      ]

    // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
    let clean_output_value =
      assets.policies(treasury_output.value) == [ada_policy_id, own_policy_id]

    // [spec MemberWithdraw 6]: output ADA = input ADA - withdrawal_amount
    let output_ada = assets.lovelace_of(treasury_output.value)
    let ada_balance_correct = output_ada == input_ada - withdrawal_amount

    and {
      member_authorized?,
      withdrawal_valid?,
      datum_frozen?,
      output_at_script?,
      token_retained?,
      clean_output_value?,
      ada_balance_correct?,
    }
  }
}

// ─── Spend: TerminateGroup ────────────────────────────────────────────────────

// validate_spend_terminate_group
// ─────────────────────────────────────────────────────────────────────────────
// [spec PenaltyWithdraw 1]: datum must be PenaltyState — only penalty UTxOs
//                           can be withdrawn this way (TreasuryState uses ExitGroup)
// [spec PenaltyWithdraw 2]: membership token is burned (verified in mint handler)
// [spec PenaltyWithdraw 3]: admin must hold the group (222) user token derived
//                           from group_reference_tokenname in the PenaltyState datum —
//                           prevents any wallet from draining penalty UTxOs
//
// NOTE: group state is NOT touched here. member_count was already decremented at
//       ExitGroup time, so the rotation continued unblocked. TerminateGroup only
//       burns the penalty token and releases the locked ADA to the admin.
pub fn validate_spend_terminate_group(
  own_policy_id: PolicyId,
  datum: TreasuryDatum,
  group_policy_id: PolicyId,
  admin_input_index: Int,
  inputs: List<Input>,
  mint: Value,
) -> Bool {
  // [spec PenaltyWithdraw 1]: datum must be PenaltyState
  expect PenaltyState { member_reference_tokenname, group_reference_tokenname } =
    datum

  // [spec PenaltyWithdraw 3]: admin (222) user token derived from group reference token name
  let admin_token_name =
    cip68.prefix_222
      |> bytearray.concat(
          bytearray.drop(group_reference_tokenname, cip68.prefix_length),
        )

  expect Some(admin_input) = list.at(inputs, admin_input_index)
  let admin_authorized =
    assets.quantity_of(
      admin_input.output.value,
      group_policy_id,
      admin_token_name,
    ) == 1

  // [spec PenaltyWithdraw 2]: membership token burned in same tx
  // (the mint handler also enforces exactly 1 token burned — belt-and-suspenders)
  let token_burned =
    assets.quantity_of(mint, own_policy_id, member_reference_tokenname) == -1

  and {
    admin_authorized?,
    token_burned?,
  }
}
