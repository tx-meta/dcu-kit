use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use governance/types.{MintAnchor, SettingsRedeemer}

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
// hashes in its datum, breaking the cross-validator hash cycle: every other
// validator is parameterized by this policy and reads the anchor as a reference
// input to learn the trusted hashes at run time (the ROSCA settings-NFT role).
// No burn path — the charter is permanent reference data.
//
// STAGE 3 SCAFFOLD: always-succeeds. Real checks land in Stage 5 (see TODOs).
validator governance_settings(_seed: OutputReference) {
  mint(redeemer: SettingsRedeemer, _policy_id: PolicyId, _tx: Transaction) {
    let MintAnchor { .. } = redeemer
    // TODO [spec 3.3.2]: the `seed` parameter OutputReference is spent in
    //   tx.inputs (one-shot — ties this policy to a unique consumed UTxO).
    // TODO [spec 3.3.2]: exactly one token of this policy minted (+1) with the
    //   fixed anchor token name; no other token under this policy.
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
