use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}

/// Protocol settings — the trusted policy IDs of the three DCU validators.
///
/// Published exactly once in an immutable settings UTxO (locked at the always-fails
/// address) alongside a singleton settings NFT. Validators parameterized by the
/// settings-NFT policy read these trusted IDs (via `read_settings`) to authenticate
/// cross-validator inputs — closing the untrusted group↔treasury binding that is the
/// root of audit findings C1/C2/C3/m1. See [[p5-settings-nft-plan]].
pub type ProtocolSettings {
  account_policy: PolicyId,
  group_policy: PolicyId,
  treasury_policy: PolicyId,
}

/// Fixed asset name of the singleton settings NFT — "settings" in UTF-8.
pub const settings_token_name: AssetName = #"73657474696e6773"

/// Locate the settings UTxO among the transaction's reference inputs by the singleton
/// settings NFT (exactly one token of `settings_token_name` under `settings_policy`),
/// and return its trusted `ProtocolSettings` datum.
///
/// Safe because the settings NFT is one-shot: only a single token can ever exist under
/// `settings_policy`, so this uniquely and unforgeably identifies the real settings
/// UTxO. `settings_policy` is supplied by the caller — a validator parameterized by it
/// at compile time — so it cannot be substituted. Fails if the NFT is absent or the
/// datum is malformed.
pub fn read_settings(
  reference_inputs: List<Input>,
  settings_policy: PolicyId,
) -> ProtocolSettings {
  expect Some(settings_input) = list.find(
    reference_inputs,
    fn(i) {
      assets.quantity_of(i.output.value, settings_policy, settings_token_name) == 1
    },
  )
  expect InlineDatum(d) = settings_input.output.datum
  expect settings: ProtocolSettings = d
  settings
}

/// One-shot mint check for the settings NFT.
///
/// Mints EXACTLY ONE settings NFT, EVER: the `seed` output reference must be spent in
/// the minting transaction, and a UTxO can only be spent once, so the policy can never
/// mint a second time. Also pins the mint to a single token under this policy (no extra
/// tokens piggy-backed). The offchain deploy step then locks the NFT + `ProtocolSettings`
/// datum in an immutable settings UTxO at the always-fails address.
pub fn validate_settings_mint(
  seed: OutputReference,
  own_policy_id: PolicyId,
  tx: Transaction,
) -> Bool {
  let seed_spent = list.any(tx.inputs, fn(i) { i.output_reference == seed })
  let mint_is_singleton = dict.to_pairs(assets.tokens(tx.mint, own_policy_id)) == [
    Pair(settings_token_name, 1),
  ]
  seed_spent && mint_is_singleton
}
