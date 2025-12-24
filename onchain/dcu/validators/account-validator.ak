use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use dcu/account.{AccountDatum, AccountRedeemer}

validator account {
  mint(_redeemer: AccountRedeemer, _policy_id: PolicyId, _self: Transaction) {
    // TODO: CreateAccount
    // - Retrieve input at input_index to derive unique token names (CIP-68)
    // - Validate exactly two assets are minted: Reference NFT (prefix 100) and User NFT (prefix 222).
    // - Ensure Reference NFT goes to script address with valid Account Datum (email_hash, phone_hash).
    // - Ensure User NFT goes to a non-script address (wallet).

    // TODO: DeleteAccount
    // - Validate input_index to find Account UTxO.
    // - Validate user_input_index to prove ownership (User NFT).
    // - Ensure Reference NFT is burned.
    // - Verify no active memberships exist (likely an off-chain check or via oracle/ref input if possible).
    trace @"Account Validator - Mint"
    True
  }

  spend(
    _datum: Option<AccountDatum>,
    _redeemer: AccountRedeemer,
    _utxo: OutputReference,
    _self: Transaction,
  ) {
    // TODO: UpdateAccount
    // - Validate Account UTxO input (account_input_index).
    // - Validate User input (user_input_index) contains User NFT.
    // - Ensure output at account_output_index goes to script with updated Account Datum.
    // - Validate metadata update constraints.

    // TODO: RemoveAccount
    // - Validate Account UTxO input.
    // - Validate User input (ownership).
    // - Ensure Reference NFT is burned (checked in minting policy, but good to cross-verify if needed).

    trace @"Account Validator - Spend"
    True
  }

  else(_) {
    trace @"Account Validator - Fallback"
    True
  }
}
