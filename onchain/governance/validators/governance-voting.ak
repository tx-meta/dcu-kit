use cardano/address.{Credential}
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}
use governance/types.{
  CastAction, ExecuteAction, ExpireAction, FinalizeAction, OpenAction,
  VotingAction,
}

// governance_voting(settings_policy) — the withdraw-zero home of ALL heavy logic.
// ─────────────────────────────────────────────────────────────────────────────
// Executed once per transaction in this handler, triggered by a zero-lovelace
// withdrawal from this script's stake credential. It validates every lifecycle
// transition (open, cast, finalize, execute, expire) against the anchor charter
// (read as a reference input, authenticated by settings_policy's NFT) and the
// proposal datum. Splitting this out is mandatory: primitive #7's monolith
// reached 97% of the deploy-size ceiling and governance's logic is heavier.
//
// STAGE 3 SCAFFOLD: always-succeeds. Real checks land in Stage 5 (see TODOs).
validator governance_voting(_settings_policy: PolicyId) {
  withdraw(redeemer: VotingAction, _credential: Credential, _self: Transaction) {
    when redeemer is {
      OpenAction { .. } ->
        // TODO [spec 3.3.4 OpenAction]: opener authorized per
        //   charter.opener_policy[action_tag]; target_id in governed_targets;
        //   the new Proposal copies voting_mode/quorum/threshold from the
        //   charter, deadline in the future, zero tallies, status = Open.
        True
      CastAction { .. } ->
        // TODO [spec 3.3.4 CastAction]: proposal Open and now <= deadline;
        //   voter presents a member_policy token; weight = 1 (1m1v) or
        //   share_units from the referenced savings account (share-weighted);
        //   tally_yes/tally_no += weight, votes_cast += 1.
        True
      FinalizeAction { .. } ->
        // TODO [spec 3.3.4 FinalizeAction]: proposal Open and now > deadline;
        //   cast = tally_yes + tally_no; Passed iff cast >= quorum and
        //   tally_yes*10000 >= threshold*cast (else Rejected); set
        //   timelock_until = now + charter.timelock on pass.
        True
      ExecuteAction { .. } ->
        // TODO [spec 3.3.4 ExecuteAction]: proposal Passed; now >=
        //   timelock_until; within exec_deadline; exactly one Decision token
        //   (name = proposal_id) locked at gate_hash bound to (target_id,
        //   action, exec_deadline); status -> Executed.
        True
      ExpireAction { .. } ->
        // TODO [spec 3.3.4 ExpireAction]: Open past deadline under quorum, or
        //   stale past exec_deadline; status -> Expired; burn the Proposal NFT.
        True
    }
  }

  // [security]: else must fail — no deregistration, votes, or proposals from
  // this stake credential; withdraw-zero is its only role.
  else(_) {
    fail
  }
}
