use aiken/collection/list
use aiken_design_patterns/stake_validator
use cardano/address.{Credential, Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}
use dcu/group.{GroupCip68Datum, GroupDatum}
use dcu/settings.{read_settings}
use dcu/treasury.{
  ClaimPayout, ClaimPenalty, Contribute, DistributeRound, DistributeWithdraw,
  ExitGroup, ExtendGrace, JoinGroup, TerminateDefault, TreasuryDatum,
  TreasuryRedeemer, TreasuryWithdrawRedeemer, UpdatePayout,
} as treasury_types
use dcu/treasury_validation.{
  validate_claim_payout, validate_claim_penalty, validate_claim_penalty_mint,
  validate_contribute, validate_distribute_withdraw, validate_exit_treasury,
  validate_extend_grace, validate_join_treasury, validate_terminate_default,
  validate_update_payout,
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
          treasury_datum,
          self,
        )
      }

      // JoinGroup is a mint redeemer — reject at spend
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
