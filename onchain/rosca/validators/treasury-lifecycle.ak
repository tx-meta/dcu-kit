use cardano/address.{Credential}
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}
use dcu/settings.{read_settings}
use dcu/treasury_actions.{LifecycleAction, run_lifecycle_action}

// treasury_lifecycle(settings_policy)
// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE family stake validator (withdraw-zero) — membership and round-cycle
// operations: join, exit, contribute, update-payout, extend-grace, claim-payout,
// claim-penalty, terminate-default. One action executes per tx; its
// covered_inputs (first field, pin-rule convention) names the treasury spending
// inputs it validates, and the runner re-binds the list to the exact arity each
// variant covers. The dispatcher accepts a lifecycle spend only when the
// withdrawal from THIS credential (settings.treasury_lifecycle_stake) covers it,
// and accepts the JoinGroup mint only when the action is a JoinAction (tag 0).
validator treasury_lifecycle(settings_policy: PolicyId) {
  withdraw(
    redeemer: LifecycleAction,
    _credential: Credential,
    self: Transaction,
  ) {
    let settings = read_settings(self.reference_inputs, settings_policy)
    run_lifecycle_action(redeemer, settings, self)
  }

  // [security]: else must fail — blocks deregistration certificates (a deregistered
  // credential would brick every lifecycle-family endpoint until re-registered),
  // governance votes, and proposals from this script credential.
  else(_) {
    fail
  }
}
