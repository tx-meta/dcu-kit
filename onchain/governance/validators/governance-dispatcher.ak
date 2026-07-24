use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use governance/dispatch.{validate_mint, validate_spend}
use governance/types.{GovMintRedeemer, GovSpendRedeemer, GovernanceDatum}

// governance_dispatcher(settings_policy) — the DISPATCHER.
// ─────────────────────────────────────────────────────────────────────────────
// The identity of a governance instance: proposal NFTs, vote receipts, and
// decision tokens are all minted under this hash, and the anchor + every
// proposal UTxO sit at its address. It validates nothing heavy — each mint and
// spend confirms that the coupled withdrawal from the published voting validator
// runs the MATCHING action (withdraw-zero), plus the token shape and, for
// proposal spends, that exactly one proposal is spent (no double satisfaction).
// Keeping it thin is what lets the lifecycle logic grow without pushing this
// script toward the deploy-size ceiling.
validator governance_dispatcher(settings_policy: PolicyId) {
  mint(redeemer: GovMintRedeemer, policy_id: PolicyId, tx: Transaction) {
    validate_mint(settings_policy, redeemer, policy_id, tx)
  }

  spend(
    datum: Option<GovernanceDatum>,
    redeemer: GovSpendRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    // [security]: datum must be present — guards against datum-less injection.
    expect Some(gov_datum) = datum
    validate_spend(settings_policy, gov_datum, redeemer, own_ref, self)
  }

  // [security]: else must fail — the dispatcher credential is never withdrawn
  // from or used for certificates/votes; blocks those purposes.
  else(_) {
    fail
  }
}
