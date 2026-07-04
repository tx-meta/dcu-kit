use cardano/address.{Credential}
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}
use dcu/settings.{read_settings}
use dcu/treasury_actions.{ReserveAction, run_reserve_action}

// treasury_reserve(settings_policy)
// ─────────────────────────────────────────────────────────────────────────────
// RESERVE family stake validator (withdraw-zero) — the group's mutual reserve
// pot: create (one-shot with the group mint), top-up, cover (TerminateDefault
// leg), refund (wind-down exit leg), close (deleteGroup). One action executes
// per tx; covered_inputs (pin-rule convention) names the reserve UTxO it
// validates — the companion treasury input in composed txs (defaulter, exiting
// member) is covered by its own lifecycle action. The dispatcher accepts a
// reserve spend only when the withdrawal from THIS credential
// (settings.treasury_reserve_stake) covers it, and accepts the CreateReserve
// mint only when the action is a CreateAction (tag 0).
validator treasury_reserve(settings_policy: PolicyId) {
  withdraw(redeemer: ReserveAction, _credential: Credential, self: Transaction) {
    let settings = read_settings(self.reference_inputs, settings_policy)
    run_reserve_action(redeemer, settings, self)
  }

  // [security]: else must fail — blocks deregistration certificates (a deregistered
  // credential would brick every reserve-family endpoint until re-registered),
  // governance votes, and proposals from this script credential.
  else(_) {
    fail
  }
}
