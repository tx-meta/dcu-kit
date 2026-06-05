use cardano/assets.{AssetName}

/// Maximum number of grace window extensions an admin can grant a defaulting member.
pub const max_grace_extensions: Int = 2

/// Treasury Validator Datum (Sum Type)
pub type TreasuryDatum {
  TreasuryState {
    group_reference_tokenname: AssetName,
    member_reference_tokenname: AssetName,
    assigned_slot: Int,
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
    // Rotation slot — preserved so TreasuryState can be fully reconstructed on recovery.
    assigned_slot: Int,
    // Payment key hash — preserved for payout routing on recovery.
    member_payment_credential: ByteArray,
    // Pull mode only: any unclaimed earmark carried in from TreasuryState when the
    // member defaulted. Preserved through the grace window so a recovered member can
    // still ClaimPayout it (and so it is reconstructed faithfully on recovery). 0 under
    // Push. The earmarked funds themselves stay in this UTxO's value either way.
    claimable_balance: Int,
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
  DistributeRound {
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
  // Resets a treasury UTxO after all rounds have been distributed, preparing
  // it for the next rotation cycle. Must be called atomically with the group
  // NextCycle handler (group is spent in the same tx and output shows reset).
  NextCycle {
    group_input_index: Int,
    group_output_index: Int,
    treasury_input_indices: List<Int>,
    treasury_output_indices: List<Int>,
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
}
