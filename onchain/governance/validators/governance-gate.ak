use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use governance/types.{Authorize, Decision, GateDatum, GateRedeemer}
use governance/validation.{validate_authorize}

// governance_gate(gov_policy) — the composition seam.
// ─────────────────────────────────────────────────────────────────────────────
// An escrow or savings fund sets its `quorum: Credential` to this validator's
// script credential. A decision token from a passed proposal is locked here;
// when the group performs the approved action, that action's transaction spends
// the decision UTxO at this address — which satisfies the other family's
// unchanged `credential_authorized(Script(gate))` check. The gate validates the
// decision is genuine, bound to the target vault, and burned on use (one-shot).
// Parameterized by the dispatcher policy so it recognizes genuine decisions.
validator governance_gate(gov_policy: PolicyId) {
  spend(
    datum: Option<GateDatum>,
    redeemer: GateRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    // [security]: datum must be present — guards against datum-less injection.
    expect Some(Decision { target_id, .. }) = datum
    let Authorize { decision_input_index, target_input_index } = redeemer
    validate_authorize(
      gov_policy,
      target_id,
      decision_input_index,
      target_input_index,
      own_ref,
      self,
    )
  }

  // [security]: else must fail — the gate credential only guards decision spends.
  else(_) {
    fail
  }
}
