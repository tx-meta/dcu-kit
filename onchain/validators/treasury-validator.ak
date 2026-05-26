use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}
use dcu/group.{GroupDatum}
use dcu/treasury.{
  Contribute, DeferRound, DistributeRound, ExitGroup, ExtendGraceWindow,
  JoinGroup, NextCycle, TerminateGroup, TreasuryDatum, TreasuryRedeemer,
  UpdatePayoutCredential, validate_contribute, validate_defer_round,
  validate_distribute_round, validate_exit_group, validate_extend_grace_window,
  validate_join_group, validate_next_cycle, validate_spend_terminate_group,
  validate_terminate_group, validate_update_payout_credential,
} as treasury_types

// treasury(account_policy_id)
// ─────────────────────────────────────────────────────────────────────────────
// Manages ROSCA membership UTxOs for DCU groups. Each member holds one treasury
// UTxO containing a CIP-68 membership token (derived from their account user
// token) and a TreasuryState datum tracking their contribution rounds.
//
// Parameter:
//   account_policy_id — the DCU account validator's policy ID. Used to verify
//   that member inputs hold a real Account NFT, not an arbitrary token.
//
// mint  — JoinGroup:     issue 1 membership token, lock fees in treasury UTxO
//       — TerminateGroup / ExitGroup (mature): burn exactly 1 membership token
//
// spend — DistributeRound:         release round contribution to the borrower
//       — ExitGroup:               pre/post-cycle free exit; in-cycle → penalty UTxO
//       — TerminateGroup:          admin withdraws a penalty UTxO (PenaltyState)
//       — Contribute:              member tops up treasury balance
//       — DeferRound:              member defers their payout round
//       — UpdatePayoutCredential:  member updates payout destination
//       — ExtendGraceWindow:       admin extends a defaulting member's grace window
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

      // All other redeemers are spend-only — reject at mint
      _ -> fail
    }
  }

  spend(
    datum: Option<TreasuryDatum>,
    redeemer: TreasuryRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, reference_inputs, mint, .. } = self

    // [security]: datum must be present — guards against datum-less UTxO injection
    expect Some(treasury_datum) = datum

    when redeemer is {
      DistributeRound {
        round_number,
        group_ref_input_index,
        group_output_index,
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

        validate_distribute_round(
          // [security]: own policy_id derived from UTxO's script credential
          policy_id_from_utxo(inputs, utxo),
          round_number,
          group_ref_input_index,
          group_output_index,
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

      TerminateGroup { group_input_index, admin_input_index } -> {
        // Derive group_policy_id from the group input's script credential.
        // TerminateGroup does NOT update group state — only reads it for admin auth.
        expect Some(group_input) = list.at(inputs, group_input_index)
        expect Script(group_policy_id) =
          group_input.output.address.payment_credential

        validate_spend_terminate_group(
          policy_id_from_utxo(inputs, utxo),
          treasury_datum,
          group_policy_id,
          admin_input_index,
          inputs,
          mint,
        )
      }

      Contribute {
        member_input_index,
        treasury_input_index,
        treasury_output_index,
      } -> {
        // [security]: self-reference check
        expect Some(treasury_input) = list.at(inputs, treasury_input_index)
        expect treasury_input.output_reference == utxo

        validate_contribute(
          policy_id_from_utxo(inputs, utxo),
          account_policy_id,
          member_input_index,
          treasury_output_index,
          treasury_datum,
          utxo,
          self,
        )
      }

      DeferRound {
        round_number,
        member_input_index,
        treasury_input_index,
        treasury_output_index,
      } -> {
        // [security]: self-reference check
        expect Some(treasury_input) = list.at(inputs, treasury_input_index)
        expect treasury_input.output_reference == utxo

        validate_defer_round(
          policy_id_from_utxo(inputs, utxo),
          account_policy_id,
          round_number,
          member_input_index,
          treasury_output_index,
          treasury_datum,
          utxo,
          self,
        )
      }

      UpdatePayoutCredential {
        member_input_index,
        treasury_input_index,
        treasury_output_index,
      } -> {
        // [security]: self-reference check
        expect Some(treasury_input) = list.at(inputs, treasury_input_index)
        expect treasury_input.output_reference == utxo

        validate_update_payout_credential(
          policy_id_from_utxo(inputs, utxo),
          account_policy_id,
          member_input_index,
          treasury_output_index,
          treasury_datum,
          utxo,
          self,
        )
      }

      ExtendGraceWindow {
        group_ref_input_index,
        admin_input_index,
        treasury_input_index,
        treasury_output_index,
      } -> {
        // [security]: self-reference check
        expect Some(treasury_input) = list.at(inputs, treasury_input_index)
        expect treasury_input.output_reference == utxo

        // Derive group_policy_id and grace_period_length from the group reference input.
        // The group is NOT spent here — only read for admin token auth and grace window length.
        expect Some(group_ref_input) =
          list.at(reference_inputs, group_ref_input_index)
        expect Script(group_policy_id) =
          group_ref_input.output.address.payment_credential
        expect InlineDatum(gd) = group_ref_input.output.datum
        expect gd_typed: GroupDatum = gd

        validate_extend_grace_window(
          policy_id_from_utxo(inputs, utxo),
          group_policy_id,
          gd_typed.grace_period_length,
          admin_input_index,
          treasury_output_index,
          treasury_datum,
          utxo,
          self,
        )
      }

      NextCycle {
        group_input_index,
        group_output_index,
        treasury_input_indices,
        treasury_output_indices,
      } -> {
        // [security]: self-reference — own UTxO must appear in treasury_input_indices
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

        validate_next_cycle(
          policy_id_from_utxo(inputs, utxo),
          group_input_index,
          group_output_index,
          treasury_input_indices,
          treasury_output_indices,
          treasury_datum,
          utxo,
          self,
        )
      }

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
