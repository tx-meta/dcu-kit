use cardano/address.{Credential}
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}
use dcu/settings.{read_settings}
use dcu/treasury.{DistributeWithdraw,
  TreasuryWithdrawRedeemer} as treasury_types
use dcu/treasury_validation.{validate_distribute_withdraw}

// treasury_rounds(settings_policy)
// ─────────────────────────────────────────────────────────────────────────────
// ROUNDS family stake validator — the once-per-tx home of the heavy distribute
// validation (withdraw-zero). Spending N treasury UTxOs runs the dispatcher's
// thin spend handler N times; the global member-set logic executes ONCE here,
// triggered by a 0-ADA withdrawal from this script's stake credential. The
// multi-UTxO indexer inside requires EVERY spent treasury UTxO to be covered,
// so this family needs no covered_inputs pin (completeness is global).
//
// Trust: the treasury/group policies come from the settings UTxO (singleton
// settings NFT) — the same trust anchor the dispatcher uses. The dispatcher
// accepts DistributeRound spends only when a withdrawal from THIS script's
// credential (settings.treasury_rounds_stake) is present.
validator treasury_rounds(settings_policy: PolicyId) {
  withdraw(
    redeemer: TreasuryWithdrawRedeemer,
    _credential: Credential,
    self: Transaction,
  ) {
    let settings = read_settings(self.reference_inputs, settings_policy)

    // DistributeWithdraw is the only rounds redeemer, so destructure it directly.
    let  
        DistributeWithdraw {
          round_number,
          group_ref_input_index,
          group_output_index,
          treasury_input_indices,
          treasury_output_indices,
          borrower_output_index,
        }
      = redeemer
    validate_distribute_withdraw(
      settings.treasury_policy,
      settings.group_policy,
      round_number,
      group_ref_input_index,
      group_output_index,
      treasury_input_indices,
      treasury_output_indices,
      borrower_output_index,
      self,
    )
  }

  // [security]: else must fail — blocks deregistration certificates (a deregistered
  // credential would brick every rounds-family endpoint until re-registered),
  // governance votes, and proposals from this script credential. Registration
  // itself needs no script witness.
  else(_) {
    fail
  }
}
