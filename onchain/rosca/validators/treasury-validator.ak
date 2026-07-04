use aiken_design_patterns/stake_validator
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use dcu/dispatch.{action_covers_own_input, action_tag_is}
use dcu/settings.{read_settings}
use dcu/treasury.{
  ApproveRecovery, CancelRecovery, ClaimPayout, ClaimPenalty, Contribute,
  CreateReserve, DistributeRound, ExecuteRecovery, ExitGroup, ExtendGrace,
  JoinGroup, ProposeRecovery, ReserveClose, ReserveCover, ReserveRefund,
  ReserveTopUp, TerminateDefault, TreasuryDatum, TreasuryRedeemer, UpdatePayout,
} as treasury_types
use dcu/treasury_validation.{
  validate_cancel_recovery_mint, validate_claim_penalty_mint,
}

// treasury(settings_policy) — the DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────
// The treasury policy/payment identity of the protocol: membership, penalty,
// recovery, and reserve tokens are minted under this hash, and every member
// treasury UTxO sits at its script address. It validates NOTHING heavy itself —
// all validation lives in the four family stake validators (rounds / lifecycle /
// recovery / reserve, hashes published in ProtocolSettings) and runs ONCE per tx
// in their withdraw handlers (withdraw-zero).
//
// spend — requires the family withdrawal to be present AND its action to COVER
//         this UTxO (pin rule, dcu/dispatch). DistributeRound needs presence
//         only: the rounds indexer enforces completeness over every spent
//         treasury UTxO globally.
// mint  — JoinGroup / ProposeRecovery / CreateReserve require the family
//         withdrawal's action to be the mint-triggering variant (constr tag 0);
//         burn paths keep their inline exact-burn checks (the corresponding
//         spend input already forces the full family validation).
validator treasury(settings_policy: PolicyId) {
  mint(redeemer: TreasuryRedeemer, policy_id: PolicyId, tx: Transaction) {
    let settings = read_settings(tx.reference_inputs, settings_policy)

    when redeemer is {
      // [security]: the lifecycle withdrawal must run a JoinAction (tag 0) —
      // it validates the minted token, the group transition, and the created
      // treasury UTxO. Without the tag check, any lifecycle action would
      // license this mint.
      JoinGroup { withdraw_redeemer_index } ->
        action_tag_is(
          settings.treasury_lifecycle_stake,
          tx.redeemers,
          withdraw_redeemer_index,
          0,
        )

      // ClaimPenalty covers the PenaltyWithdraw burn path.
      // ExitGroup covers the mature (inactive/past-rotation) burn path.
      // TerminateDefault covers the admin-forced defaulter forfeiture burn path.
      // ExecuteRecovery burns exactly N (the lost member's old identity token).
      // ReserveClose burns exactly the reserve token.
      // All require exactly 1 token burned under this policy; the spend handler
      // of the covered treasury input forces the full family validation, which
      // pins the burned name.
      ClaimPenalty { .. } -> validate_claim_penalty_mint(policy_id, tx.mint)
      ExitGroup { .. } -> validate_claim_penalty_mint(policy_id, tx.mint)
      TerminateDefault { .. } -> validate_claim_penalty_mint(policy_id, tx.mint)
      ExecuteRecovery { .. } -> validate_claim_penalty_mint(policy_id, tx.mint)
      ReserveClose { .. } -> validate_claim_penalty_mint(policy_id, tx.mint)

      // CancelRecovery burns exactly N' (the authenticating token for the
      // request); the spend handler forces the full recovery validation.
      CancelRecovery { .. } -> validate_cancel_recovery_mint(policy_id, tx.mint)

      // [security]: the recovery withdrawal must run a ProposeAction (tag 0) —
      // it validates the minted N' and the created RecoveryRequest UTxO.
      ProposeRecovery { withdraw_redeemer_index } ->
        action_tag_is(
          settings.treasury_recovery_stake,
          tx.redeemers,
          withdraw_redeemer_index,
          0,
        )

      // [security]: the reserve withdrawal must run a CreateAction (tag 0) —
      // it validates the minted reserve token and its one-shot coupling to the
      // group-creation mint.
      CreateReserve { withdraw_redeemer_index } ->
        action_tag_is(
          settings.treasury_reserve_stake,
          tx.redeemers,
          withdraw_redeemer_index,
          0,
        )

      // All other redeemers are spend-only — reject at mint.
      _ -> fail
    }
  }

  spend(
    datum: Option<TreasuryDatum>,
    redeemer: TreasuryRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    // [security]: datum must be present — guards against datum-less UTxO injection.
    expect Some(_treasury_datum) = datum

    // Trusted family stake-validator hashes from the settings UTxO (authenticated
    // by the singleton settings NFT).
    let settings = read_settings(self.reference_inputs, settings_policy)

    when redeemer is {
      // [security]: withdraw-zero coupling (unchanged shape). The heavy round
      // validation runs exactly once in the ROUNDS stake validator; a
      // script-credential withdrawal always triggers it, and its multi-UTxO
      // indexer requires EVERY spent treasury UTxO to be covered — so presence
      // is sufficient for this family.
      DistributeRound { withdrawal_index } ->
        stake_validator.validate_withdraw_minimal(
          settings.treasury_rounds_stake,
          self.withdrawals,
          withdrawal_index,
        )

      // [security]: pin rule — the family action must explicitly cover THIS
      // UTxO (see dcu/dispatch for the attack a presence-only check allows).
      ExitGroup { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_lifecycle_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )
      Contribute { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_lifecycle_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )
      UpdatePayout { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_lifecycle_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )
      ExtendGrace { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_lifecycle_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )
      ClaimPayout { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_lifecycle_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )
      ClaimPenalty { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_lifecycle_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )
      TerminateDefault { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_lifecycle_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )

      ApproveRecovery { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_recovery_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )
      CancelRecovery { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_recovery_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )
      ExecuteRecovery { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_recovery_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )

      ReserveTopUp { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_reserve_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )
      ReserveCover { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_reserve_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )
      ReserveRefund { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_reserve_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )
      ReserveClose { withdraw_redeemer_index } ->
        action_covers_own_input(
          settings.treasury_reserve_stake,
          self.redeemers,
          withdraw_redeemer_index,
          self.inputs,
          utxo,
        )

      // JoinGroup / ProposeRecovery / CreateReserve are mint redeemers — reject
      // at spend.
      _ -> fail
    }
  }

  // [security]: else branch must fail — the dispatcher's stake credential is
  // never registered or withdrawn from (the family stake validators carry the
  // withdraw-zero role now); this blocks unauthorized withdrawals, certificate
  // publications, governance votes, and proposals from the treasury credential.
  else(_) {
    fail
  }
}
