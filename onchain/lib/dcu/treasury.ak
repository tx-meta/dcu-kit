use cardano/assets.{AssetName}

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
    contribution_list: List<Contribution>,
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
    member_input_index: Int,
    treasury_output_index: Int,
  }
  TerminateGroup
  DistributePayout {
    group_ref_input_index: Int,
    treasury_input_indices: List<Int>,
    treasury_output_indices: List<Int>,
    borrower_output_index: Int,
  }
  ExitGroup {
    group_ref_input_index: Int,
    member_input_index: Int,
    treasury_input_index: Int,
    penalty_output_index: Int,
  }
  MemberWithdraw {
    group_ref_input_index: Int,
    member_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
    loans_withdrawn: Int,
  }
}
