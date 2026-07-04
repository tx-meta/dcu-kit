use cardano/assets.{AssetName}

/// Maximum number of grace window extensions an admin can grant a defaulting member.
pub const max_grace_extensions: Int = 2

/// Treasury Validator Datum (Sum Type)
pub type TreasuryDatum {
  // NOTE (Recommit): the rotation slot no longer lives here — the group datum's
  // member_slots map (parallel to member_token_names) is the single authority. The
  // borrower for a round is resolved from the group registry by token name.
  TreasuryState {
    group_reference_tokenname: AssetName,
    member_reference_tokenname: AssetName,
    // Number of distribution rounds this member has contributed to.
    // Starts at 0; incremented by DistributeRound. Used to enforce sequential
    // round processing: each treasury instance must be at rounds_paid == round_number.
    rounds_paid: Int,
    // Payment key hash of the member's wallet; used in DistributeRound (Push mode)
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
    // Payment key hash — preserved for payout routing on recovery.
    member_payment_credential: ByteArray,
    // Pull mode only: any unclaimed earmark carried in from TreasuryState when the
    // member defaulted. Preserved through the grace window so a recovered member can
    // still ClaimPayout it (and so it is reconstructed faithfully on recovery). 0 under
    // Push. The earmarked funds themselves stay in this UTxO's value either way.
    claimable_balance: Int,
  }
  // Pending lost-member recovery. Authenticated by holding exactly the freshly-minted
  // treasury-side token `new_member_tokenname` (N') — same pattern as a treasury UTxO
  // holding its membership token. Consumed by ApproveRecovery (re-created with one more
  // approval), CancelRecovery (veto), or ExecuteRecovery (rotates the lost member's position).
  RecoveryRequest {
    group_reference_tokenname: AssetName,
    target_token: AssetName,
    new_member_tokenname: AssetName,
    new_payment_credential: ByteArray,
    earliest_execution_slot: Int,
    approvals: List<AssetName>,
  }
  // Mutual reserve pot — exactly one per group, created in the createGroup tx.
  // Identity: holds the reserve token (prefix_rsv + the group ref token's unique
  // part) under this policy. Accrues join/round levies and forfeited defaulter
  // collateral; stands in for terminated defaulters at DistributeRound; refunds
  // pro-rata at wind-down. Appended LAST to keep existing Constr indices stable.
  ReserveState {
    group_reference_tokenname: AssetName,
    // Remaining fee-units the reserve stands in for terminated defaulters (one
    // unit drawn per DistributeRound while > 0 — decrements even when the pot is
    // dry so owed cover always drains). Flat pool: overlapping defaults extend
    // duration, not per-round depth.
    standin_rounds: Int,
  }
}

/// Treasury Validator Redeemer.
///
/// The treasury script is a thin DISPATCHER: all heavy validation lives in the four
/// family stake validators (rounds / lifecycle / recovery / reserve — hashes published
/// in ProtocolSettings) and runs ONCE per tx in their `withdraw` handlers. Spend
/// variants therefore carry only `withdraw_redeemer_index` — the index into
/// `tx.redeemers` of the family withdrawal whose action must COVER this UTxO (the pin
/// rule, see dcu/dispatch). The action indices themselves live on the family withdraw
/// redeemer (single source of truth). DistributeRound keeps its original shape: the
/// rounds indexer enforces completeness globally, so a withdrawal-presence check
/// (`withdrawal_index` into tx.withdrawals) suffices.
///
/// Variant ORDER is unchanged from the monolith (constr indices stable where the
/// variant survives; field shapes are the wire-level break of this cycle).
pub type TreasuryRedeemer {
  // Mint: issue 1 membership token + create the treasury UTxO. Requires the
  // lifecycle withdrawal to run a JoinAction (constr tag 0).
  JoinGroup { withdraw_redeemer_index: Int }
  // Spend: admin withdraws a PenaltyState UTxO. At mint: exact-1-burn check.
  ClaimPenalty { withdraw_redeemer_index: Int }
  // Withdraw-zero coupling (unchanged): each treasury spend asserts a withdrawal
  // from the ROUNDS stake validator is present (at withdrawal_index in
  // tx.withdrawals); the rounds `withdraw` handler validates the complete round and
  // its multi-UTxO indexer covers EVERY spent treasury UTxO.
  DistributeRound { withdrawal_index: Int }
  // Spend: member exit (free pre/post-cycle; in-cycle → penalty UTxO). At mint:
  // exact-1-burn check (mature exit burns the membership token).
  ExitGroup { withdraw_redeemer_index: Int }
  // Spend: member tops up their treasury balance.
  Contribute { withdraw_redeemer_index: Int }
  // Spend: member updates their payout destination credential.
  UpdatePayout { withdraw_redeemer_index: Int }
  // Spend: admin grants a grace window extension to a member in DefaultState.
  ExtendGrace { withdraw_redeemer_index: Int }
  // Spend (Pull mode): member withdraws their earmarked claimable_balance.
  ClaimPayout { withdraw_redeemer_index: Int }
  // Spend: admin terminates an expired defaulter. At mint: exact-1-burn check.
  TerminateDefault { withdraw_redeemer_index: Int }
  // Mint: issue N' for a new RecoveryRequest UTxO. Requires the recovery
  // withdrawal to run a ProposeAction (constr tag 0).
  ProposeRecovery { withdraw_redeemer_index: Int }
  // Spend: add one approval to a RecoveryRequest.
  ApproveRecovery { withdraw_redeemer_index: Int }
  // Spend: veto a RecoveryRequest. At mint: exact-N'-burn check.
  CancelRecovery { withdraw_redeemer_index: Int }
  // Spend: rotate the lost member's position (carried by BOTH the request and the
  // member treasury input — the recovery ExecuteAction covers both). At mint:
  // exact-burn check of N (the old identity token).
  ExecuteRecovery { withdraw_redeemer_index: Int }
  // Mint: issue the group's reserve token (one-shot with the group-creation mint).
  // Requires the reserve withdrawal to run a CreateAction (constr tag 0).
  CreateReserve { withdraw_redeemer_index: Int }
  // Spend: increase-only reserve top-up (join levy leg + donations).
  ReserveTopUp { withdraw_redeemer_index: Int }
  // Spend: reserve leg of a TerminateDefault (forfeit flows in, stand-in grows).
  ReserveCover { withdraw_redeemer_index: Int }
  // Spend: wind-down equal-split refund riding a member exit.
  ReserveRefund { withdraw_redeemer_index: Int }
  // Spend: close the reserve in the deleteGroup tx. At mint: exact-1-burn check.
  ReserveClose { withdraw_redeemer_index: Int }
}

/// Treasury Withdraw-Validator Redeemer (the "withdraw-zero" coupling).
///
/// DistributeRound spends N member treasury UTxOs in one tx. Running the global member-set
/// validation in the per-input `spend` handler re-executes it N times → O(N³). Instead, that
/// heavy logic runs ONCE here in the
/// treasury `withdraw` handler (triggered by a 0-ADA reward withdrawal from the
/// treasury's own stake credential), and each `spend` only asserts this withdrawal is
/// present. The treasury validator is self-coupled: the staking script hash == the
/// spending script hash == the treasury policy id.
pub type TreasuryWithdrawRedeemer {
  // Validates a complete distribute round in one pass: trusted group binding, pro-rata
  // pot (active_members × fee), borrower payout, and every treasury input↔output
  // balance/datum transition. Mirrors the old per-input DistributeRound logic exactly,
  // folded over the full member set via the multi-UTxO indexer.
  DistributeWithdraw {
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
}
