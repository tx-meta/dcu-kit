use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use governance/types.{Authorize, GateDatum, GateRedeemer}

// governance_gate(gov_policy) — the composition seam.
// ─────────────────────────────────────────────────────────────────────────────
// An escrow or savings fund sets its `quorum: Credential` to this validator's
// script credential. A decision token from a passed proposal is locked here;
// when the group performs the approved action, that action's transaction spends
// the decision UTxO at this address — which is exactly what satisfies the
// other family's unchanged `credential_authorized(Script(gate))` check (its
// Script path needs a spent input at that credential, not a bare reference
// input). The gate validates the decision binds to the vault and action being
// performed, then burns it (one-shot; no replay). Escrow/savings change by
// zero bytes. Parameterized by the dispatcher policy so it recognizes genuine
// decision tokens.
//
// STAGE 3 SCAFFOLD: always-succeeds. Real checks land in Stage 5 (see TODOs).
validator governance_gate(_gov_policy: PolicyId) {
  spend(
    datum: Option<GateDatum>,
    redeemer: GateRedeemer,
    _utxo: OutputReference,
    _self: Transaction,
  ) {
    // [security]: datum must be present — guards against datum-less injection.
    expect Some(_gate_datum) = datum
    let Authorize { .. } = redeemer
    // TODO [spec 3.3.5 Authorize]: self-reference — inputs[decision_input_index]
    //   is this UTxO and holds a gov_policy decision token.
    // TODO [spec 3.3.5 Authorize]: binding — inputs[target_input_index] is the
    //   vault named by datum.target_id, and that vault's own redeemer (located
    //   by purpose) is datum.action with matching parameters.
    // TODO [spec 3.3.5 Authorize]: freshness — if exec_deadline = Some(d),
    //   now <= d.
    // TODO [spec 3.3.5 Authorize]: one-shot — the decision token is burned this
    //   transaction (no replay).
    // TODO [spec 3.3.5 Authorize]: no double satisfaction — exactly one decision
    //   per authorized action, matched by strictly-increasing index
    //   (multi_utxo_indexer).
    True
  }

  // [security]: else must fail — the gate credential only ever guards decision
  // spends.
  else(_) {
    fail
  }
}
