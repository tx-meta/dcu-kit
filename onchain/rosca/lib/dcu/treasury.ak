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
  // Withdraw-zero coupling: the heavy round validation runs ONCE in the treasury
  // `withdraw` handler (DistributeWithdraw). Each treasury spend only asserts that a
  // withdrawal from the treasury's own stake credential is present (at withdrawal_index
  // in tx.withdrawals) — a script-credential withdrawal always triggers that handler,
  // which validates the complete round, so this UTxO cannot be spent without it.
  DistributeRound { withdrawal_index: Int }
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
  // Pull mode: member withdraws their earmarked payout (claimable_balance) to any
  // address. Auth is possession of the member (222) token — bearer model, so a member
  // who lost their original wallet can still claim from a new one holding the token.
  ClaimPayout {
    // Group UTxO as a reference input — read only for the contribution asset identity.
    group_ref_input_index: Int,
    member_input_index: Int,
    treasury_output_index: Int,
  }
  // Admin terminates a member stuck in DefaultState after their grace window (including
  // any extensions) has fully expired. The membership token is burned, the group's
  // member_count decrements (the group is spent with the Exit redeemer in the same tx),
  // and the forfeited collateral is claimed by the admin who builds the transaction.
  // Time-gated (now > grace_expires_at) and admin-only, so it is neutral and fair: grace
  // plus extensions are always offered before a defaulter can be removed. Appended LAST to
  // keep the Constr indices of all existing variants stable.
  TerminateDefault {
    // Group SPENDING input — spent with the group Exit redeemer to decrement member_count.
    group_ref_input_index: Int,
    // Group output showing member_count decremented and the member removed from the registry.
    group_output_index: Int,
    // Admin input holding the group (222) user token.
    admin_input_index: Int,
    // Self-reference — the defaulter's DefaultState treasury UTxO.
    treasury_input_index: Int,
  }
  ProposeRecovery {
    group_ref_input_index: Int,
    request_output_index: Int,
    approver_input_indices: List<Int>,
  }
  ApproveRecovery {
    group_ref_input_index: Int,
    request_input_index: Int,
    request_output_index: Int,
    approver_input_index: Int,
  }
  CancelRecovery { request_input_index: Int }
  ExecuteRecovery {
    group_ref_input_index: Int,
    group_output_index: Int,
    request_input_index: Int,
    member_treasury_input_index: Int,
    member_treasury_output_index: Int,
  }
  // Mints the group's reserve token and creates the ReserveState UTxO. Valid ONLY
  // in the same tx as the group-creation mint (one-shot coupling — the group ref
  // token must itself be minted). Mint-only redeemer. Appended LAST to keep the
  // Constr indices of all existing variants stable.
  CreateReserve {
    group_output_index: Int,
    reserve_output_index: Int,
  }
  // Increase-only spend of the ReserveState UTxO: the join levy leg of a JoinGroup
  // tx and voluntary top-ups. Datum frozen, token preserved, contribution-asset
  // balance strictly grows. Spend-only redeemer.
  ReserveTopUp {
    reserve_input_index: Int,
    reserve_output_index: Int,
  }
  // Reserve leg of a TerminateDefault: the defaulter's forfeited balance flows
  // INTO the reserve and the stand-in counter grows by their remaining rounds
  // this lap. Pinned to a genuine termination (DefaultState input + token burn +
  // registry removal). Spend-only redeemer.
  ReserveCover {
    group_ref_input_index: Int,
    group_output_index: Int,
    defaulter_input_index: Int,
    reserve_input_index: Int,
    reserve_output_index: Int,
  }
  // Wind-down reserve refund: rides a member's ExitGroup while the group is
  // deactivated. Each exiting member may take at most floor(balance /
  // pre-exit member_count) — self-adjusting equal split, remainders roll
  // forward. Datum frozen. Spend-only redeemer.
  ReserveRefund {
    group_ref_input_index: Int,
    group_output_index: Int,
    exiting_treasury_input_index: Int,
    reserve_input_index: Int,
    reserve_output_index: Int,
  }
  // Closes the reserve UTxO in the deleteGroup tx: the group ref token and the
  // reserve token burn together (member_count == 0). Residue leaves with the
  // builder. Spend redeemer; at mint it validates the single-token burn.
  ReserveClose { group_input_index: Int }
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
