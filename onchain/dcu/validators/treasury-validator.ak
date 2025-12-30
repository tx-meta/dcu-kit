use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use dcu/treasury.{TreasuryDatum, TreasuryRedeemer} as treasury_types

validator treasury {
  mint(_redeemer: TreasuryRedeemer, _policy_id: PolicyId, _self: Transaction) {
    // TODO: JoinGroup
    // - Validate Account NFT input (member identity).
    // - Validate Group Spending Input (update member count).
    // - Validate Treasury Output:
    //   - Goes to Script.
    //   - Contains valid Treasury Datum.
    // - Validate contribution fee & joining fee paid (locked in Treasury UTxO).
    // - Mint exactly one Membership Token (TokenName: "treasury-membership").
    // - Ensure User NFT goes to member, Membership Token goes to script (or stays with UTxO logic).
    // TODO: TerminateGroup
    // - Burn exactly one Membership Token.
    // - Validate Group Reference Input (Group Datum).
    // - Ensure appropriate logic for termination (e.g. all members exited or force close).
    trace @"Treasury Validator - Mint"
    True
  }

  spend(
    _datum: Option<TreasuryDatum>,
    _redeemer: TreasuryRedeemer,
    _utxo: OutputReference,
    _self: Transaction,
  ) {
    // TODO: DistributePayout ("trustless collection")
    // - Validate "Borrower" output (recipient).
    // - Verify Borrower holds valid Slot NFT matching current interval/rotation schedule.
    // - Validate Treasury UTxOs being spent (treasury_input_indices).
    // - Validate Group Reference Input (Rotation Schedule).
    // - Ensure Borrower receives collected claimable amounts.
    // - Ensure Treasury UTxOs return to script with updated "paid" status in datums.

    // TODO: ExitGroup
    // - Validate Member Input (Account NFT).
    // - Validate Treasury UTxO input.
    // - Validate Group Spending Input (decrement member count).
    // - Decision:
    //   - If active & early exit -> Output Penalty Datum (deduct penalty fee).
    //   - If inactive/matured -> Burn Membership Token (no penalty).

    // TODO: MemberWithdraw
    // - Validate Member Input (Account NFT).
    // - Validate Treasury UTxO input.
    // - Validate Group Reference Input (eligibility).
    // - Check vesting schedule/linear vesting logic.
    // - If inactive -> Allow full withdrawal & burn Membership Token.
    trace @"Treasury Validator - Spend"
    True
  }

  else(_) {
    trace @"Treasury Validator - Fallback"
    True
  }
}
