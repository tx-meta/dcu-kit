use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, OutputReference, Transaction}
use dcu/treasury.{
  DistributePayout, ExitGroup, JoinGroup, MemberWithdraw, TerminateGroup,
  TreasuryDatum, TreasuryRedeemer, validate_distribute_payout,
  validate_exit_group, validate_join_group, validate_member_withdraw,
  validate_spend_terminate_group, validate_terminate_group,
} as treasury_types

// treasury(account_policy_id)
// ─────────────────────────────────────────────────────────────────────────────
// Manages ROSCA membership UTxOs for DCU groups. Each member holds one treasury
// UTxO containing a CIP-68 membership token (derived from their account user
// token) and a TreasuryState datum tracking their contribution schedule.
//
// Parameter:
//   account_policy_id — the DCU account validator's policy ID. Used to verify
//   that member inputs hold a real Account NFT, not an arbitrary token.
//
// mint  — JoinGroup:     issue 1 membership token, lock fees in treasury UTxO
//       — TerminateGroup / ExitGroup (mature): burn exactly 1 membership token
//
// spend — DistributePayout: release claimable contributions to the borrower
//       — ExitGroup:         early exit → penalty UTxO; mature exit → burn token
//       — MemberWithdraw:    member claims their own locked contributions
//       — TerminateGroup:    admin withdraws a penalty UTxO (PenaltyState)
validator treasury(account_policy_id: PolicyId) {
  mint(redeemer: TreasuryRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { mint, .. } = tx

    when redeemer is {
      JoinGroup {
        group_ref_input_index,
        group_output_index,
        member_input_index,
        treasury_output_index,
      } ->
        validate_join_group(
          policy_id,
          account_policy_id,
          group_ref_input_index,
          group_output_index,
          member_input_index,
          treasury_output_index,
          tx,
        )

      // TerminateGroup redeemer covers PenaltyWithdraw burn path.
      // ExitGroup redeemer covers mature (inactive/past-rotation) burn path.
      // Both paths require exactly 1 token burned under this policy.
      TerminateGroup { .. } -> validate_terminate_group(policy_id, mint)
      ExitGroup { .. } -> validate_terminate_group(policy_id, mint)

      // DistributePayout and MemberWithdraw are spend redeemers — reject at mint
      _ -> fail
    }
  }

  spend(
    datum: Option<TreasuryDatum>,
    redeemer: TreasuryRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, mint, .. } = self

    // [security]: datum must be present — guards against datum-less UTxO injection
    expect Some(treasury_datum) = datum

    when redeemer is {
      DistributePayout {
        group_ref_input_index,
        treasury_input_indices,
        treasury_output_indices,
        borrower_output_index,
      } -> {
        // [security]: self-reference — own UTxO must appear in treasury_input_indices,
        // preventing cross-UTxO attacks where a different treasury's UTxO is substituted.
        expect
          list.any(
            treasury_input_indices,
            fn(idx) {
              when list.at(inputs, idx) is {
                Some(i) -> i.output_reference == utxo
                None -> False
              }
            },
          )

        validate_distribute_payout(
          // [security]: own policy_id derived from UTxO's script credential
          // — cannot be spoofed via redeemer
          policy_id_from_utxo(inputs, utxo),
          group_ref_input_index,
          treasury_input_indices,
          treasury_output_indices,
          borrower_output_index,
          treasury_datum,
          utxo,
          self,
        )
      }

      ExitGroup {
        group_ref_input_index,
        group_output_index,
        member_input_index,
        treasury_input_index,
        penalty_output_index,
      } -> {
        // [security]: self-reference — treasury_input_index must resolve to own UTxO
        expect Some(treasury_input) = list.at(inputs, treasury_input_index)
        expect treasury_input.output_reference == utxo

        validate_exit_group(
          policy_id_from_utxo(inputs, utxo),
          account_policy_id,
          group_ref_input_index,
          group_output_index,
          member_input_index,
          penalty_output_index,
          treasury_datum,
          self,
        )
      }

      MemberWithdraw {
        group_ref_input_index,
        member_input_index,
        treasury_input_index,
        treasury_output_index,
        withdrawal_amount,
      } -> {
        // [security]: self-reference — treasury_input_index must resolve to own UTxO
        expect Some(treasury_input) = list.at(inputs, treasury_input_index)
        expect treasury_input.output_reference == utxo

        validate_member_withdraw(
          policy_id_from_utxo(inputs, utxo),
          account_policy_id,
          group_ref_input_index,
          member_input_index,
          treasury_output_index,
          withdrawal_amount,
          treasury_datum,
          utxo,
          self,
        )
      }

      TerminateGroup { group_input_index, admin_input_index } ->
        validate_spend_terminate_group(
          policy_id_from_utxo(inputs, utxo),
          treasury_datum,
          group_input_index,
          admin_input_index,
          inputs,
          mint,
        )

      // JoinGroup is a mint redeemer — reject at spend
      _ -> fail
    }
  }

  // [security]: else branch must fail — prevents unauthorized staking withdrawals
  // and governance votes from the treasury script address.
  else(_) {
    fail
  }
}

// policy_id_from_utxo
// Derives the treasury policy_id from the script address of the UTxO being
// spent. This avoids passing the treasury policy_id as a validator parameter.
// The address is trusted because it comes from the transaction inputs, not
// from the redeemer.
fn policy_id_from_utxo(inputs: List<Input>, utxo: OutputReference) -> PolicyId {
  expect Some(own_input) =
    list.find(inputs, fn(i) { i.output_reference == utxo })
  expect Script(policy_id) = own_input.output.address.payment_credential
  policy_id
}
