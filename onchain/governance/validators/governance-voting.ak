use cardano/address.{Credential}
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}
use governance/types.{
  CastAction, ExecuteAction, ExpireAction, FinalizeAction, OpenAction,
  RegisterAction, VotingAction,
}
use governance/validation.{read_anchor}
use governance/voting.{
  validate_cast, validate_execute, validate_expire, validate_finalize,
  validate_open, validate_register,
}

// governance_voting(settings_policy) — the withdraw-zero home of ALL heavy logic.
// ─────────────────────────────────────────────────────────────────────────────
// Executed once per transaction, triggered by a zero-lovelace withdrawal from
// this script's stake credential. It reads the anchor charter (a reference input
// authenticated by settings_policy's NFT) and validates the lifecycle transition
// carried by the redeemer. The thin dispatcher couples to this withdrawal, so
// the heavy checks run once regardless of how many proposal UTxOs are spent.
validator governance_voting(settings_policy: PolicyId) {
  withdraw(redeemer: VotingAction, _credential: Credential, self: Transaction) {
    let anchor = read_anchor(self.reference_inputs, settings_policy)
    when redeemer is {
      OpenAction { proposal_output_index, opener_index } ->
        validate_open(anchor, proposal_output_index, opener_index, self)
      CastAction {
        proposal_input_index,
        proposal_output_index,
        voter_index,
        record_input_index,
        record_output_index,
        share_ref_index,
        approve,
      } ->
        validate_cast(
          anchor,
          proposal_input_index,
          proposal_output_index,
          voter_index,
          record_input_index,
          record_output_index,
          share_ref_index,
          approve,
          self,
        )
      FinalizeAction { proposal_input_index, proposal_output_index } ->
        validate_finalize(
          anchor,
          proposal_input_index,
          proposal_output_index,
          self,
        )
      ExecuteAction {
        proposal_input_index,
        proposal_output_index,
        decision_output_index,
      } ->
        validate_execute(
          anchor,
          proposal_input_index,
          proposal_output_index,
          decision_output_index,
          self,
        )
      ExpireAction { proposal_input_index } ->
        validate_expire(proposal_input_index, self)
      RegisterAction {
        roster_input_index,
        roster_output_index,
        record_output_index,
        member_index,
      } ->
        validate_register(
          anchor,
          settings_policy,
          roster_input_index,
          roster_output_index,
          record_output_index,
          member_index,
          self,
        )
    }
  }

  // [security]: else must fail — no deregistration, votes, or proposals from
  // this stake credential; withdraw-zero is its only role.
  else(_) {
    fail
  }
}
