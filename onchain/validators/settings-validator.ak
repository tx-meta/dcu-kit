use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use dcu/settings.{validate_settings_mint}

// settings_nft(seed) — one-shot minting policy for the protocol settings NFT.
//
// Mints EXACTLY ONE settings NFT, EVER: the `seed` output reference must be spent in
// the minting transaction. Because a UTxO can only ever be spent once, the policy can
// never mint a second time — making the NFT a permanent singleton. The NFT then lives
// (with the ProtocolSettings datum) in an immutable settings UTxO at the always-fails
// address, read by the other validators via reference inputs to authenticate the
// trusted protocol policy IDs. Mint-only; any other purpose fails.
validator settings_nft(seed: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    validate_settings_mint(seed, policy_id, tx)
  }

  else(_) {
    fail
  }
}
