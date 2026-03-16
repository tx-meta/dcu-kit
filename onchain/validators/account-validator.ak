use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use dcu/account.{
  AccountDatum, AccountRedeemer, CreateAccount, DeleteAccount, RemoveAccount,
  UpdateAccount, validate_create_account, validate_delete_account,
  validate_remove_account, validate_update_account,
} as account_types

// account_validator
// ─────────────────────────────────────────────────────────────────────────────
// Manages CIP-68 account identity NFTs for DCU members. Each account is
// represented by a Reference NFT (prefix-100) held at the script address and a
// User NFT (prefix-222) held in the member's wallet.
//
// mint  — CreateAccount: issue ref + user NFT pair
//       — DeleteAccount: burn both tokens (called alongside RemoveAccount spend)
//
// spend — UpdateAccount: update AccountDatum, requires user NFT as proof
//       — RemoveAccount: consume account UTxO + burn ref token, requires user NFT
validator account {
  mint(redeemer: AccountRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, outputs, mint, .. } = tx

    when redeemer is {
      CreateAccount { input_index, output_index } ->
        validate_create_account(
          policy_id,
          input_index,
          output_index,
          inputs,
          outputs,
          mint,
        )

      DeleteAccount { reference_token_name } ->
        validate_delete_account(policy_id, reference_token_name, mint)

      // UpdateAccount and RemoveAccount are spend redeemers — reject at mint
      _ -> fail
    }
  }

  spend(
    datum: Option<AccountDatum>,
    redeemer: AccountRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, mint, .. } = self

    // [security]: datum must be present — guards against datum-less UTxO injection
    expect Some(_) = datum

    // [security]: extract own policy_id from the UTxO being spent
    expect Some(own_input) =
      list.find(inputs, fn(i) { i.output_reference == utxo })
    expect Script(policy_id) = own_input.output.address.payment_credential

    when redeemer is {
      UpdateAccount {
        reference_token_name,
        user_input_index,
        account_input_index,
        account_output_index,
      } -> {
        // [security]: self-reference — account_input_index must resolve to the UTxO
        // being spent, preventing cross-UTxO attacks where a different account's
        // UTxO is substituted to bypass per-UTxO guards.
        expect Some(account_input) = list.at(inputs, account_input_index)
        expect account_input.output_reference == utxo

        validate_update_account(
          policy_id,
          reference_token_name,
          user_input_index,
          account_input_index,
          account_output_index,
          inputs,
          outputs,
        )
      }

      RemoveAccount {
        reference_token_name,
        user_input_index,
        account_input_index,
      } -> {
        // [security]: self-reference — same pattern as UpdateAccount above
        expect Some(account_input) = list.at(inputs, account_input_index)
        expect account_input.output_reference == utxo

        validate_remove_account(
          policy_id,
          reference_token_name,
          user_input_index,
          account_input_index,
          inputs,
          mint,
        )
      }

      // CreateAccount and DeleteAccount are mint redeemers — reject at spend
      _ -> fail
    }
  }

  // [security]: else branch must fail — prevents unauthorized staking withdrawals
  // and governance votes from the account script address.
  else(_) {
    fail
  }
}
