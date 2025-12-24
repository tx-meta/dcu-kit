use cardano/assets.{AssetName}

/// Account Validator Datum
pub type AccountDatum {
  email_hash: ByteArray, // Hash<ByteArray, Sha2_256> (32 bytes)
  phone_hash: ByteArray, // Hash<ByteArray, Sha2_256> (32 bytes)
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
  RemoveAccount {
    reference_token_name: AssetName,
    user_input_index: Int,
    account_input_index: Int,
  }
  DeleteAccount { reference_token_name: AssetName }
}
