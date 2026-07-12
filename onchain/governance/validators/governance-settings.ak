use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use governance/types.{MintAnchor, SettingsRedeemer}
use governance/validation.{validate_mint_anchor}

// governance_settings(seed) — one-shot minting policy for the Governance Anchor
// NFT, parameterized by the seed OutputReference.
// ─────────────────────────────────────────────────────────────────────────────
// The seed parameter makes this policy — and therefore the whole instance's
// dispatcher, voting, and gate hashes — UNIQUE per governance instance. That is
// what lets a target vault's `quorum: Credential` commit to exactly one
// instance's gate: a decision minted under another instance's dispatcher is
// spendable only at that instance's gate, never at the vault's. A shared policy
// would let any instance authorize any vault sharing a target id.
//
// The anchor UTxO this NFT authenticates publishes the voting and gate script
// hashes in its datum; every other validator reads it as a reference input to
// learn the trusted hashes at run time. No burn path — the charter is permanent.
validator governance_settings(seed: OutputReference) {
  mint(redeemer: SettingsRedeemer, policy_id: PolicyId, tx: Transaction) {
    let MintAnchor { anchor_output_index } = redeemer
    let Transaction { inputs, outputs, mint, .. } = tx
    validate_mint_anchor(
      seed,
      policy_id,
      anchor_output_index,
      inputs,
      outputs,
      mint,
    )
  }

  // [security]: no other purpose — settings is mint-only.
  else(_) {
    fail
  }
}
