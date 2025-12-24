use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use dcu/group.{GroupDatum, GroupRedeemer} as group_types

validator group {
  mint(_redeemer: GroupRedeemer, _policy_id: PolicyId, _self: Transaction) {
    // TODO: CreateGroup
    // - Retrieve input at input_index to derive unique token names (CIP-68).
    // - Validate exactly two assets are minted: Reference NFT (prefix 100) and User NFT (prefix 222).
    // - Ensure Reference NFT goes to script address with valid Group Datum.
    // - Validate Group Datum:
    //   - contribution_fee > 0
    //   - joining_fee >= 0
    //   - penalty_fee >= 0
    //   - interval_length > 0
    //   - num_intervals > 0
    //   - member_count == 0
    //   - is_active == True
    trace @"Group Validator - Mint"
    True
  }

  spend(
    _datum: Option<GroupDatum>,
    _redeemer: GroupRedeemer,
    _utxo: OutputReference,
    _self: Transaction,
  ) {
    // TODO: UpdateGroup
    // - Validate Group UTxO input (group_input_index).
    // - Validate Admin input (admin_input_index) checks ownership (Reference Token logic vs User Token logic).
    // - Ensure output at group_output_index goes to script with updated Group Datum.
    // - Constraints: Critical changes (fees, intervals) only allowed if member_count == 0.
    // - Ensure Group NFT preserved in output.

    // TODO: RemoveGroup
    // - Validate Group UTxO input.
    // - Validate Admin input (ownership).
    // - Ensure output Group Datum has is_active == False.
    // - Ensure member_count == 0 before deactivation allowed.
    // - Ensure Group NFT preserved.

    trace @"Group Validator - Spend"
    True
  }

  else(_) {
    trace @"Group Validator - Fallback"
    True
  }
}
