use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use governance/types.{
  BurnDecision, BurnProposal, CastVote, Execute, ExecuteProposal, Expire,
  Finalize, GovMintRedeemer, GovSpendRedeemer, GovernanceDatum, OpenProposal,
  UpdateCharter, Vote,
}

// governance_dispatcher(settings_policy) — the DISPATCHER.
// ─────────────────────────────────────────────────────────────────────────────
// The identity of a governance instance: proposal NFTs, vote receipts, and
// decision tokens are all minted under this hash, and the anchor + every
// proposal UTxO sit at its address. It validates NOTHING heavy: every mint and
// spend variant (except BurnDecision) only confirms a coupled withdrawal from
// the published Governance Voting validator (withdraw-zero) carries the matching
// action. Keeping it thin is what lets the lifecycle logic grow without pushing
// this script toward the deploy-size ceiling.
//
// STAGE 3 SCAFFOLD: always-succeeds. Real checks land in Stage 5 (see TODOs).
validator governance_dispatcher(_settings_policy: PolicyId) {
  mint(redeemer: GovMintRedeemer, _policy_id: PolicyId, _tx: Transaction) {
    when redeemer is {
      OpenProposal { .. } ->
        // TODO [spec 3.3.3 OpenProposal]: a withdrawal from
        //   settings.voting_stake_hash at withdrawal_index runs OpenAction
        //   (constructor-tag check); exactly one Proposal State NFT minted,
        //   name = blake2b_256 of inputs[seed_input_index].output_reference;
        //   the proposal output is a fresh Proposal UTxO at this address.
        True
      CastVote { .. } ->
        // TODO [spec 3.3.3 CastVote]: a CastAction withdrawal is present;
        //   exactly one Vote Receipt minted, name =
        //   blake2b_256(proposal_id ++ voter_ref) — a re-vote reproduces an
        //   existing name and fails (one vote per member).
        True
      ExecuteProposal { .. } ->
        // TODO [spec 3.3.3 ExecuteProposal]: an ExecuteAction withdrawal is
        //   present; exactly one Decision token minted (name = proposal_id),
        //   locked at settings.gate_hash with a Decision datum binding
        //   (target_id, action, exec_deadline) copied from the proposal.
        True
      BurnProposal { .. } ->
        // TODO [spec 3.3.3 BurnProposal]: a terminal withdrawal (Finalize/
        //   Expire) is present; exactly one Proposal State NFT burned (-1).
        True
      BurnDecision ->
        // TODO [spec 3.3.3 BurnDecision]: exactly one Decision token burned;
        //   the covering gate spend forces the full authorization check, so no
        //   voting coupling is required here.
        True
    }
  }

  spend(
    datum: Option<GovernanceDatum>,
    redeemer: GovSpendRedeemer,
    _utxo: OutputReference,
    _self: Transaction,
  ) {
    // [security]: datum must be present — guards against datum-less injection.
    expect Some(_gov_datum) = datum

    when redeemer is {
      Vote { .. } ->
        // TODO [spec 3.3.3 Vote]: self-reference; a CastAction withdrawal from
        //   the anchor's voting_stake_hash covers this input; continuation
        //   integrity (only tallies + votes_cast change).
        True
      Finalize { .. } ->
        // TODO [spec 3.3.3 Finalize]: coupled FinalizeAction withdrawal;
        //   continuation changes only status + timelock_until.
        True
      Execute { .. } ->
        // TODO [spec 3.3.3 Execute]: coupled ExecuteAction withdrawal;
        //   continuation sets status = Executed; decision output produced.
        True
      Expire { .. } ->
        // TODO [spec 3.3.3 Expire]: coupled ExpireAction withdrawal; the
        //   Proposal State NFT is burned and min-ADA reclaimed.
        True
      UpdateCharter { .. } ->
        // TODO [spec 3.3.3 UpdateCharter]: creator-authorized OR a ParamChange
        //   decision consumed at the gate; published hashes, creator, and
        //   member_policy are immutable; only tunable fields may change.
        True
    }
  }

  // [security]: else must fail — the dispatcher credential is never withdrawn
  // from or used for certificates/votes; blocks those purposes.
  else(_) {
    fail
  }
}
