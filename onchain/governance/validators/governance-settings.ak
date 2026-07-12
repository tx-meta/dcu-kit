use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}
use governance/types.{MintAnchor, SettingsRedeemer}

// governance_settings — one-shot minting policy for the Governance Anchor NFT.
// ─────────────────────────────────────────────────────────────────────────────
// The anchor UTxO this NFT authenticates publishes the voting and gate script
// hashes in its datum, breaking the cross-validator hash cycle: every other
// validator is parameterized by THIS policy and reads the anchor as a reference
// input to learn the trusted hashes at run time (the ROSCA settings-NFT role).
// No burn path — the charter is permanent reference data.
//
// STAGE 3 SCAFFOLD: always-succeeds. Real checks land in Stage 5 (see TODOs).
validator governance_settings {
  mint(redeemer: SettingsRedeemer, _policy_id: PolicyId, _tx: Transaction) {
    let MintAnchor { .. } = redeemer
    // TODO [spec 3.3.2]: inputs[seed_input_index] is spent; the minted NFT
    //   name == blake2b_256 of its OutputReference (one-shot uniqueness).
    // TODO [spec 3.3.2]: exactly one token of this policy minted (+1); no
    //   other token under this policy.
    // TODO [spec 3.3.2]: outputs[anchor_output_index] sits at the dispatcher
    //   script address, holds the minted NFT, and carries a well-formed
    //   GovernanceAnchor datum with non-empty voting_stake_hash and gate_hash.
    // TODO [spec 3.3.2]: burn case is fail (permanent reference data).
    True
  }

  // [security]: no other purpose — settings is mint-only.
  else(_) {
    fail
  }
}
