use cardano/address.{Credential}
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}
use dcu/settings.{read_settings}
use dcu/treasury_actions.{RecoveryAction, run_recovery_action}

// treasury_recovery(settings_policy)
// ─────────────────────────────────────────────────────────────────────────────
// RECOVERY family stake validator (withdraw-zero) — lost-member identity
// rotation: propose, approve, cancel (veto), execute. One action executes per
// tx; covered_inputs (pin-rule convention) names the treasury spending inputs it
// validates (ExecuteAction covers BOTH the request and the member treasury
// input). The dispatcher accepts a recovery spend only when the withdrawal from
// THIS credential (settings.treasury_recovery_stake) covers it, and accepts the
// ProposeRecovery mint only when the action is a ProposeAction (tag 0).
validator treasury_recovery(settings_policy: PolicyId) {
  withdraw(redeemer: RecoveryAction, _credential: Credential, self: Transaction) {
    let settings = read_settings(self.reference_inputs, settings_policy)
    run_recovery_action(redeemer, settings, self)
  }

  // [security]: else must fail — blocks deregistration certificates (a deregistered
  // credential would brick every recovery-family endpoint until re-registered),
  // governance votes, and proposals from this script credential.
  else(_) {
    fail
  }
}
