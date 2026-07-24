use aiken/cbor
use aiken/collection/list
use aiken/crypto.{blake2b_256}
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets.{AssetName}
use cardano/transaction.{OutputReference, Transaction}

// [spec 3.1]: VK => signature present; Script => some spent input sits at that
// script's payment credential, forcing the script (native multisig or Plutus)
// to validate. Same rule as the escrow quorum socket.
pub fn credential_authorized(cred: Credential, tx: Transaction) -> Bool {
  when cred is {
    VerificationKey(pkh) -> list.has(tx.extra_signatories, pkh)
    Script(sh) ->
      list.any(
        tx.inputs,
        fn(i) { i.output.address.payment_credential == Script(sh) },
      )
  }
}

// One-shot uniqueness: 32-byte digest of the seed OutputReference (full
// blake2b_256; no CIP-68 prefix — a single state token, not a ref/user pair).
pub fn state_token_name(seed: OutputReference) -> AssetName {
  blake2b_256(cbor.serialise(seed))
}
