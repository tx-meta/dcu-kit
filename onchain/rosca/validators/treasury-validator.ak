use aiken/collection/list
use aiken_design_patterns/stake_validator
use cardano/address.{Credential, Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}
use dcu/group.{GroupCip68Datum, GroupDatum}
use dcu/settings.{read_settings}
use dcu/reserve.{
  validate_create_reserve, validate_reserve_close, validate_reserve_cover,
  validate_reserve_refund, validate_reserve_topup,
}
use dcu/treasury.{
  ApproveRecovery, CancelRecovery, ClaimPayout, ClaimPenalty, Contribute,
  CreateReserve, DistributeRound, DistributeWithdraw, ExecuteRecovery, ExitGroup,
  ExtendGrace, JoinGroup, ProposeRecovery, ReserveClose, ReserveCover,
  ReserveRefund, ReserveTopUp, TerminateDefault, TreasuryDatum,
  TreasuryRedeemer, TreasuryWithdrawRedeemer, UpdatePayout,
} as treasury_types
use dcu/treasury_validation.{
  validate_approve_recovery, validate_cancel_recovery, validate_cancel_recovery_mint,
  validate_claim_payout, validate_claim_penalty, validate_claim_penalty_mint,
  validate_contribute, validate_distribute_withdraw, validate_execute_recovery,
  validate_exit_treasury, validate_extend_grace, validate_join_treasury,
  validate_propose_recovery, validate_terminate_default, validate_update_payout,
}

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
//       — UpdatePayoutCredential:  member updates payout destination
//       — ExtendGraceWindow:       admin extends a defaulting member's grace window
validator treasury(settings_policy: PolicyId) {
  mint(redeemer: TreasuryRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { mint, reference_inputs, .. } = tx

    when redeemer is {
      JoinGroup {
        group_ref_input_index,
        group_output_index,
        member_input_index,
        treasury_output_index,
      } -> {
        // Trusted protocol policies from the settings UTxO (singleton settings NFT).
        let settings = read_settings(reference_inputs, settings_policy)
        validate_join_treasury(
          policy_id,
          settings.account_policy,
          settings.group_policy,
          group_ref_input_index,
          group_output_index,
          member_input_index,
          treasury_output_index,
          tx,
        )
      }

      // ClaimPenalty redeemer covers PenaltyWithdraw burn path.
      // ExitGroup redeemer covers mature (inactive/past-rotation) burn path.
      // TerminateDefault covers the admin-forced defaulter forfeiture burn path.
      // All three require exactly 1 token burned under this policy.
      ClaimPenalty { .. } -> validate_claim_penalty_mint(policy_id, mint)
      ExitGroup { .. } -> validate_claim_penalty_mint(policy_id, mint)
      TerminateDefault { .. } -> validate_claim_penalty_mint(policy_id, mint)

      ProposeRecovery {
        group_ref_input_index,
        request_output_index,
        approver_input_indices,
      } -> {
        // Trusted protocol policies from the settings UTxO (same trust anchor as
        // JoinGroup) — account_policy authenticates approver/recoveree tokens,
        // group_policy authenticates the trusted group reference input.
        let settings = read_settings(reference_inputs, settings_policy)
        validate_propose_recovery(
          policy_id,
          settings.account_policy,
          settings.group_policy,
          group_ref_input_index,
          request_output_index,
          approver_input_indices,
          tx,
        )
      }

      // CancelRecovery burns exactly N' (the authenticating token for the request).
      // The spend handler confirms the burn name matches the request's datum N' (cross-check).
      CancelRecovery { .. } -> validate_cancel_recovery_mint(policy_id, mint)

      // ReserveClose burns exactly the reserve token (the spend handler pins the
      // deleteGroup shape and the burned name).
      ReserveClose { .. } -> validate_claim_penalty_mint(policy_id, mint)

      // ExecuteRecovery burns exactly N (the lost member's old identity token).
      // N' is relocated from the request UTxO into the rotated output — not re-minted.
      // The spend handler confirms the burned name matches the request's target_token
      // (exact_burn check in validate_execute_recovery — bidirectional pin).
      ExecuteRecovery { .. } -> validate_claim_penalty_mint(policy_id, mint)

      // CreateReserve mints the group's reserve token — valid only in the same tx
      // as the group-creation mint (one-shot coupling checked inside).
      CreateReserve { group_output_index, reserve_output_index } -> {
        let settings = read_settings(reference_inputs, settings_policy)
        validate_create_reserve(
          policy_id,
          settings.group_policy,
          group_output_index,
          reserve_output_index,
          tx,
        )
      }

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

    // Trusted protocol policies from the settings UTxO (authenticated by the singleton
    // settings NFT). Replaces deriving group_policy from an untrusted input address.
    let settings = read_settings(reference_inputs, settings_policy)

    when redeemer is {
      DistributeRound { withdrawal_index } ->
        // [security]: withdraw-zero coupling. The heavy round validation runs exactly once
        // in this validator's `withdraw` handler; each treasury spend only asserts that a
        // withdrawal from the treasury's OWN stake credential is present. A script-credential
        // withdrawal always triggers that handler, and the handler's multi-UTxO indexer
        // requires EVERY spent treasury UTxO to be covered — so substituting/excluding this
        // UTxO is rejected there (the completeness the old per-input self-reference + index
        // list used to provide is now enforced globally). There is exactly one withdrawal per
        // credential, so whichever withdraw redeemer is present fully validates this round.
        stake_validator.validate_withdraw_minimal(
          // own policy_id derived from UTxO's script credential = our own stake credential
          policy_id_from_utxo(inputs, utxo),
          self.withdrawals,
          withdrawal_index,
        )

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

        validate_exit_treasury(
          policy_id_from_utxo(inputs, utxo),
          settings.account_policy,
          settings.group_policy,
          group_ref_input_index,
          group_output_index,
          member_input_index,
          penalty_output_index,
          treasury_input.output.address,
          treasury_datum,
          self,
        )
      }

      ClaimPenalty { admin_input_index, .. } ->
        // [security C3]: the trusted group policy comes from the settings UTxO — NOT
        // derived from the group input's address — so a forged "group" cannot supply a
        // matching admin token under an attacker policy. group_ref_input_index is now
        // unused (the trusted policy is read from settings).
        validate_claim_penalty(
          policy_id_from_utxo(inputs, utxo),
          treasury_datum,
          settings.group_policy,
          admin_input_index,
          inputs,
          mint,
        )

      Contribute {
        group_ref_input_index,
        member_input_index,
        treasury_input_index,
        treasury_output_index,
      } -> {
        // [security]: self-reference check
        expect Some(treasury_input) = list.at(inputs, treasury_input_index)
        expect treasury_input.output_reference == utxo

        validate_contribute(
          policy_id_from_utxo(inputs, utxo),
          settings.account_policy,
          settings.group_policy,
          group_ref_input_index,
          member_input_index,
          treasury_output_index,
          treasury_datum,
          utxo,
          self,
        )
      }

      UpdatePayout {
        member_input_index,
        treasury_input_index,
        treasury_output_index,
      } -> {
        // [security]: self-reference check
        expect Some(treasury_input) = list.at(inputs, treasury_input_index)
        expect treasury_input.output_reference == utxo

        validate_update_payout(
          policy_id_from_utxo(inputs, utxo),
          settings.account_policy,
          member_input_index,
          treasury_output_index,
          treasury_datum,
          utxo,
          self,
        )
      }

      ExtendGrace {
        group_ref_input_index,
        admin_input_index,
        treasury_input_index,
        treasury_output_index,
      } -> {
        // [security]: self-reference check
        expect Some(treasury_input) = list.at(inputs, treasury_input_index)
        expect treasury_input.output_reference == utxo

        // Read grace_period_length from the group reference input. The trusted group
        // policy comes from the settings UTxO; [security m1] we ALSO assert the ref input
        // sits at that trusted script, so a forged "group" cannot supply a bogus grace
        // window length (or a matching admin token under an attacker policy).
        expect Some(group_ref_input) = list.at(
          reference_inputs,
          group_ref_input_index,
        )
        expect
          group_ref_input.output.address.payment_credential == Script(
            settings.group_policy,
          )
        expect InlineDatum(gd) = group_ref_input.output.datum
        expect GroupCip68Datum { extra: gd_typed, .. } = gd

        validate_extend_grace(
          policy_id_from_utxo(inputs, utxo),
          settings.group_policy,
          gd_typed.grace_period_length,
          admin_input_index,
          treasury_output_index,
          treasury_datum,
          utxo,
          self,
        )
      }

      ClaimPayout {
        group_ref_input_index,
        member_input_index,
        treasury_output_index,
      } ->
        validate_claim_payout(
          policy_id_from_utxo(inputs, utxo),
          settings.account_policy,
          settings.group_policy,
          group_ref_input_index,
          member_input_index,
          treasury_output_index,
          treasury_datum,
          utxo,
          self,
        )

      TerminateDefault {
        group_ref_input_index,
        group_output_index,
        admin_input_index,
        treasury_input_index,
      } -> {
        // [security]: self-reference — treasury_input_index must resolve to own UTxO
        expect Some(treasury_input) = list.at(inputs, treasury_input_index)
        expect treasury_input.output_reference == utxo

        // [security C3]: the trusted group policy comes from the settings UTxO, so a forged
        // "group" cannot supply a matching admin token under an attacker policy.
        validate_terminate_default(
          policy_id_from_utxo(inputs, utxo),
          settings.group_policy,
          group_ref_input_index,
          group_output_index,
          admin_input_index,
          treasury_input_index,
          treasury_datum,
          self,
        )
      }

      ApproveRecovery {
        group_ref_input_index,
        request_input_index,
        request_output_index,
        approver_input_index,
      } -> {
        // [security]: self-reference — request_input_index must resolve to own UTxO,
        // preventing cross-UTxO attacks where a different RecoveryRequest is substituted.
        // validate_approve_recovery also asserts this internally; done here too for
        // consistency with other spend handlers that assert then delegate.
        expect Some(request_input) = list.at(inputs, request_input_index)
        expect request_input.output_reference == utxo

        validate_approve_recovery(
          policy_id_from_utxo(inputs, utxo),
          settings.account_policy,
          settings.group_policy,
          group_ref_input_index,
          request_input_index,
          request_output_index,
          approver_input_index,
          utxo,
          self,
        )
      }

      CancelRecovery { request_input_index } -> {
        // [security]: self-reference — request_input_index must resolve to own UTxO,
        // preventing cross-UTxO attacks where a different RecoveryRequest is targeted.
        // validate_cancel_recovery also asserts this internally.
        expect Some(request_input) = list.at(inputs, request_input_index)
        expect request_input.output_reference == utxo

        // account_policy comes from settings so a forged account policy cannot
        // substitute arbitrary tokens for the target-token or approver proof.
        validate_cancel_recovery(
          policy_id_from_utxo(inputs, utxo),
          settings.account_policy,
          request_input_index,
          utxo,
          self,
        )
      }

      ExecuteRecovery {
        group_ref_input_index,
        group_output_index,
        request_input_index,
        member_treasury_input_index,
        member_treasury_output_index,
      } -> {
        // [security]: double self-reference — this redeemer is carried by BOTH the
        // RecoveryRequest UTxO and the member treasury UTxO. Whichever input triggered
        // this spend handler, validate that the triggered UTxO is one of the two valid
        // spending inputs indexed by the redeemer. This prevents a third, unrelated
        // treasury UTxO from using ExecuteRecovery to skip validation.
        expect Some(request_in) = list.at(inputs, request_input_index)
        expect Some(member_in) = list.at(inputs, member_treasury_input_index)
        expect
          utxo == request_in.output_reference || utxo == member_in.output_reference

        // The heavy validation runs identically regardless of which input triggered it.
        validate_execute_recovery(
          policy_id_from_utxo(inputs, utxo),
          settings.group_policy,
          group_ref_input_index,
          group_output_index,
          request_input_index,
          member_treasury_input_index,
          member_treasury_output_index,
          request_in.output_reference,
          member_in.output_reference,
          self,
        )
      }

      ReserveCover {
        group_ref_input_index,
        group_output_index,
        defaulter_input_index,
        reserve_input_index,
        reserve_output_index,
      } ->
        // Reserve leg of a TerminateDefault — pinned to a genuine termination
        // inside (DefaultState input + token burn + registry removal).
        validate_reserve_cover(
          policy_id_from_utxo(inputs, utxo),
          settings.group_policy,
          group_ref_input_index,
          group_output_index,
          defaulter_input_index,
          reserve_input_index,
          reserve_output_index,
          utxo,
          self,
        )

      ReserveRefund {
        group_ref_input_index,
        group_output_index,
        exiting_treasury_input_index,
        reserve_input_index,
        reserve_output_index,
      } ->
        // Wind-down equal-split refund riding a member exit — bounds and
        // pinning inside.
        validate_reserve_refund(
          policy_id_from_utxo(inputs, utxo),
          settings.group_policy,
          group_ref_input_index,
          group_output_index,
          exiting_treasury_input_index,
          reserve_input_index,
          reserve_output_index,
          utxo,
          self,
        )

      ReserveClose { group_input_index } ->
        // The reserve dies with its group (deleteGroup shape pinned inside).
        validate_reserve_close(
          policy_id_from_utxo(inputs, utxo),
          settings.group_policy,
          group_input_index,
          utxo,
          self,
        )

      ReserveTopUp { reserve_input_index, reserve_output_index } ->
        // Self-reference and all continuation pinning happen inside (the reserve
        // input at reserve_input_index must BE this UTxO).
        validate_reserve_topup(
          policy_id_from_utxo(inputs, utxo),
          settings.group_policy,
          reserve_input_index,
          reserve_output_index,
          treasury_datum,
          utxo,
          self,
        )

      // JoinGroup / CreateReserve are mint redeemers — reject at spend
      _ -> fail
    }
  }

  // WITHDRAW-ZERO: the once-per-tx home of the heavy round validation. Spending N
  // treasury UTxOs re-runs the spend handler N times; routing the global member-set
  // logic through a single 0-ADA withdrawal from the treasury's own stake credential
  // executes it ONCE (O(N³) → ~O(N)). The treasury is self-coupled: the staking
  // script hash == the spending script hash == own_policy_id.
  withdraw(
    redeemer: TreasuryWithdrawRedeemer,
    credential: Credential,
    self: Transaction,
  ) {
    // [security]: the staking credential being withdrawn from IS the treasury script
    // (self-coupled). Its hash is own_policy_id — used for the trusted-group binding and
    // to identify this treasury's own spend inputs in the multi-UTxO indexer.
    expect Script(own_policy_id) = credential

    // Trusted protocol policies from the settings UTxO (authenticated by the singleton
    // settings NFT) — same trust anchor the spend handlers use.
    let settings = read_settings(self.reference_inputs, settings_policy)

    // DistributeWithdraw is the only withdraw redeemer (NextCycleWithdraw was removed with the
    // continuous-round model), so destructure it directly.
    let DistributeWithdraw {
      round_number,
      group_ref_input_index,
      group_output_index,
      treasury_input_indices,
      treasury_output_indices,
      borrower_output_index,
    } = redeemer
    validate_distribute_withdraw(
      own_policy_id,
      settings.group_policy,
      round_number,
      group_ref_input_index,
      group_output_index,
      treasury_input_indices,
      treasury_output_indices,
      borrower_output_index,
      self,
    )
  }

  // [security]: else branch must fail — prevents unauthorized governance votes,
  // certificate publications, and proposals from the treasury script credential.
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
  expect Some(own_input) = list.find(
    inputs,
    fn(i) { i.output_reference == utxo },
  )
  expect Script(policy_id) = own_input.output.address.payment_credential
  policy_id
}
