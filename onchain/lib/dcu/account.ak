use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, Output}
use dcu/cip68
use dcu/utils.{output_holds_only_own}

/// Account Validator Datum
pub type AccountDatum {
  // Raw UTF-8 display name shown in the UI (username, ADA Handle, Discord handle, etc.).
  // Stored as-is — no hashing. At least one of display_name or contact must be non-empty.
  display_name: ByteArray,
  // Raw UTF-8 secondary contact identifier (social handle, email, etc.).
  // Stored as-is — no hashing.
  contact: ByteArray,
}

/// Account Validator Redeemer
pub type AccountRedeemer {
  CreateAccount { input_index: Int, output_index: Int }
  UpdateAccount {
    reference_token_name: AssetName,
    user_input_index: Int,
    account_input_index: Int,
    account_output_index: Int,
  }
  CloseAccount {
    reference_token_name: AssetName,
    user_input_index: Int,
    account_input_index: Int,
  }
  BurnAccount { reference_token_name: AssetName }
}

// is_account_datum_valid
// ─────────────────────────────────────────────────────────────────────────────
// [spec AccountDatum 1]: at least one of display_name or contact must be non-empty.
//                        Both may be set; either alone is sufficient.
pub fn is_account_datum_valid(datum: AccountDatum) -> Bool {
  let name_valid = bytearray.length(datum.display_name) > 0
  let contact_valid = bytearray.length(datum.contact) > 0
  name_valid || contact_valid
}

// validate_create_account
// ─────────────────────────────────────────────────────────────────────────────
// [spec CreateAccount 1]: input at input_index is consumed to derive unique CIP-68 names
// [spec CreateAccount 2]: exactly two tokens minted — ref (100) qty 1, user (222) qty 1
// [spec CreateAccount 3]: output at output_index is at the Account Script address
// [spec CreateAccount 4]: output holds EXACTLY the ref (100) token and no other policy tokens
// [spec CreateAccount 5]: output carries a valid AccountDatum (username/contact hash validation)
// [spec CreateAccount 6]: user (222) token must go to a VerificationKey address —
//                         if sent to a script, account authority is permanently lost
// [security     ]: output holds only ADA + own policy — prevents unbounded value accumulation
pub fn validate_create_account(
  policy_id: PolicyId,
  input_index: Int,
  output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  // [spec CreateAccount 1]: input at input_index is consumed to derive unique CIP-68 names
  expect Some(params_input) = list.at(inputs, input_index)

  let ref_token_name = cip68.unique_token_name(
    params_input.output_reference,
    cip68.prefix_100,
  )
  let user_token_name = cip68.unique_token_name(
    params_input.output_reference,
    cip68.prefix_222,
  )

  // [spec CreateAccount 2]: exactly two tokens minted — ref (100) qty 1, user (222) qty 1
  let minted_tokens = assets.tokens(mint, policy_id)
  let ref_minted = dict.get(minted_tokens, ref_token_name) == Some(1)
  let user_minted = dict.get(minted_tokens, user_token_name) == Some(1)
  let exact_mint_quantity = dict.size(minted_tokens) == 2

  // [spec CreateAccount 3]: output at output_index is at the Account Script address
  // [spec CreateAccount 4]: output holds the ref (100) token
  // [spec CreateAccount 5]: output carries a valid AccountDatum (username/contact hash validation)
  expect Some(output) = list.at(outputs, output_index)
  expect InlineDatum(d) = output.datum
  expect datum: AccountDatum = d

  // [spec CreateAccount 6]: user (222) token must go to a VerificationKey address —
  //                         if sent to a script, account authority is permanently lost
  expect Some(user_output) = list.find(
    outputs,
    fn(o) { assets.quantity_of(o.value, policy_id, user_token_name) == 1 },
  )
  let user_token_to_wallet = when user_output.address.payment_credential is {
    VerificationKey(_) -> True
    Script(_) -> False
  }

  let output_at_script_address = output.address.payment_credential == Script(
    policy_id,
  )

  let output_has_ref_token = assets.quantity_of(
    output.value,
    policy_id,
    ref_token_name,
  ) == 1

  // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
  let output_clean_value = output_holds_only_own(output.value, policy_id)

  and {
    exact_mint_quantity?,
    ref_minted?,
    user_minted?,
    output_at_script_address?,
    output_has_ref_token?,
    output_clean_value?,
    is_account_datum_valid(datum)?,
    user_token_to_wallet?,
  }
}

// validate_burn_account
// ─────────────────────────────────────────────────────────────────────────────
// [spec BurnAccount 1]: reference (100) token is burned — qty -1
// [spec BurnAccount 2]: user (222) token is burned — qty -1
// [security         3]: exactly those two tokens burned under this policy;
//                       prevents a partial burn leaving an orphaned user token
//                       or an attacker minting new tokens in the same transaction
pub fn validate_burn_account(
  policy_id: PolicyId,
  reference_token_name: AssetName,
  mint: Value,
) -> Bool {
  let user_token_name = cip68.convert_ref_to_user_token(reference_token_name)
  let minted_tokens = assets.tokens(mint, policy_id)
  // [spec BurnAccount 1]: reference (100) token is burned — qty -1
  expect Some(-1) = dict.get(minted_tokens, reference_token_name)
  // [spec BurnAccount 2]: user (222) token is burned — qty -1
  expect Some(-1) = dict.get(minted_tokens, user_token_name)
  // [security 3]: exactly those two tokens burned — prevents partial burn or
  //               attacker minting new tokens in the same transaction
  let exact_burn_quantity = dict.size(minted_tokens) == 2
  exact_burn_quantity?
}

// validate_update_account
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check (account_input_index resolves to the UTxO being spent)
//       is enforced at the entry point in account-validator.ak before this function
//       is called.
//
// [spec UpdateAccount 1]: account input at account_input_index holds the ref (100) token
// [spec UpdateAccount 2]: user input at user_input_index holds the user (222) token
//                         — proves the caller owns the account (authorization)
// [spec UpdateAccount 3]: output at account_output_index is back at the same script address
// [spec UpdateAccount 4]: output retains EXACTLY the ref (100) token — no other policy tokens
//                         (prevents account-merge when two accounts are updated in one tx)
// [spec UpdateAccount 5]: output carries a valid updated AccountDatum (username/contact hash validation)
// [security     ]: output holds only ADA + own policy — prevents unbounded value accumulation
pub fn validate_update_account(
  policy_id: PolicyId,
  reference_token_name: AssetName,
  user_input_index: Int,
  account_input_index: Int,
  account_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
) -> Bool {
  // [spec UpdateAccount 1]: account input at account_input_index holds the ref (100) token
  expect Some(account_input) = list.at(inputs, account_input_index)
  let ref_token_present = assets.quantity_of(
    account_input.output.value,
    policy_id,
    reference_token_name,
  ) == 1

  // [spec UpdateAccount 2]: user input at user_input_index holds the user (222) token
  //                         — proves the caller owns the account (authorization)
  let user_token_name = cip68.convert_ref_to_user_token(reference_token_name)
  expect Some(user_input) = list.at(inputs, user_input_index)
  let user_token_present = assets.quantity_of(
    user_input.output.value,
    policy_id,
    user_token_name,
  ) == 1

  // [spec UpdateAccount 3]: output at account_output_index is back at the same script address
  // [spec UpdateAccount 4]: output retains the ref (100) token
  // [spec UpdateAccount 5]: output carries a valid updated AccountDatum (username/contact hash validation)
  expect Some(output) = list.at(outputs, account_output_index)
  expect InlineDatum(d) = output.datum
  expect datum: AccountDatum = d

  and {
    ref_token_present?,
    user_token_present?,
    (output.address == account_input.output.address)?,
    // [spec UpdateAccount 4]: output retains EXACTLY the ref (100) token —
    //                         prevents account-merge when two accounts updated in one tx
    (dict.to_pairs(assets.tokens(output.value, policy_id)) == [
      Pair(reference_token_name, 1),
    ])?,
    // [security]: output holds only ADA + own policy — prevents unbounded value accumulation
    output_holds_only_own(output.value, policy_id)?,
    is_account_datum_valid(datum)?,
  }
}

// validate_close_account
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: self-reference check (account_input_index resolves to the UTxO being spent)
//       is enforced at the entry point in account-validator.ak before this function
//       is called.
//
// [spec CloseAccount 1]: account input at account_input_index holds the ref (100) token
// [spec CloseAccount 2]: user input at user_input_index holds the user (222) token
//                        — proves the caller owns the account (authorization)
// [spec CloseAccount 3]: ref (100) token is burned in this transaction (qty -1);
//                        ensures the account UTxO is truly deleted, not just consumed
//                        and silently re-created elsewhere
pub fn validate_close_account(
  policy_id: PolicyId,
  reference_token_name: AssetName,
  user_input_index: Int,
  account_input_index: Int,
  inputs: List<Input>,
  mint: Value,
) -> Bool {
  // [spec CloseAccount 1]: account input at account_input_index holds the ref (100) token
  expect Some(account_input) = list.at(inputs, account_input_index)
  let ref_token_present = assets.quantity_of(
    account_input.output.value,
    policy_id,
    reference_token_name,
  ) == 1

  // [spec CloseAccount 2]: user input at user_input_index holds the user (222) token
  //                        — proves the caller owns the account (authorization)
  let user_token_name = cip68.convert_ref_to_user_token(reference_token_name)
  expect Some(user_input) = list.at(inputs, user_input_index)
  let user_token_present = assets.quantity_of(
    user_input.output.value,
    policy_id,
    user_token_name,
  ) == 1

  // [spec CloseAccount 3]: ref (100) token is burned in this transaction (qty -1)
  let ref_token_burned = assets.quantity_of(
    mint,
    policy_id,
    reference_token_name,
  ) == -1

  and {
    ref_token_present?,
    user_token_present?,
    ref_token_burned?,
  }
}
