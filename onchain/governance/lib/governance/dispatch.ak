use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{blake2b_256}
use cardano/address.{Script}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  OutputReference, Redeemer, ScriptPurpose, Transaction, Withdraw,
}
use governance/types.{
  BurnDecision, BurnProposal, CastAction, CastVote, Execute, ExecuteAction,
  ExecuteProposal, Expire, ExpireAction, Finalize, FinalizeAction,
  GovMintRedeemer, GovSpendRedeemer, GovernanceAnchor, GovernanceDatum,
  OpenAction, OpenProposal, UpdateCharter, Vote, VotingAction,
}
use governance/validation.{
  credential_authorized, holds_policy, mints_exactly_one, own_policy_of,
  read_anchor,
}

// VotingAction constructor tags — the coupling contract between the thin
// dispatcher and the withdraw-zero voting validator.
const tag_open: Int = 0

const tag_cast: Int = 1

const tag_finalize: Int = 2

const tag_execute: Int = 3

const tag_expire: Int = 4

fn voting_action_tag(va: VotingAction) -> Int {
  when va is {
    OpenAction { .. } -> tag_open
    CastAction { .. } -> tag_cast
    FinalizeAction { .. } -> tag_finalize
    ExecuteAction { .. } -> tag_execute
    ExpireAction { .. } -> tag_expire
  }
}

// [security]: the coupled withdrawal must run the EXPECTED voting action. Without
// the tag check any voting action would license any dispatcher mint/spend — e.g.
// a CastAction could license an OpenProposal mint, minting a proposal NFT whose
// datum was never validated.
// Located by PURPOSE, not by index: the ledger allows exactly one withdrawal
// redeemer per credential per transaction, so searching is unambiguous and
// immune to redeemer-ordering assumptions (an index into `redeemers` is NOT the
// same as an index into `withdrawals`).
fn coupled_to(
  voting_hash: ByteArray,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  expected_tag: Int,
) -> Bool {
  expect Some(Pair(_, r)) = list.find(
    redeemers,
    fn(p) { p.1st == Withdraw(Script(voting_hash)) },
  )
  expect va: VotingAction = r
  voting_action_tag(va) == expected_tag
}

// Exactly one token under `policy` moves, with the given quantity (+1 mint /
// -1 burn) — the name is validated by the coupled voting action.
fn one_under_policy(mint: Value, policy: PolicyId, qty: Int) -> Bool {
  when dict.to_pairs(assets.tokens(mint, policy)) is {
    [Pair(_, q)] -> q == qty
    _ -> False
  }
}

// validate_mint — the dispatcher's minting purpose.
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_mint(
  settings_policy: PolicyId,
  redeemer: GovMintRedeemer,
  policy_id: PolicyId,
  tx: Transaction,
) -> Bool {
  let Transaction { inputs, outputs, mint, redeemers, reference_inputs, .. } = tx
  when redeemer is {
    // [spec 3.3.3 BurnDecision]: exactly one decision burned; the covering gate
    //   spend forces the full authorization check, so no voting coupling here.
    BurnDecision -> one_under_policy(mint, policy_id, -1)
    _ -> {
      let anchor = read_anchor(reference_inputs, settings_policy)
      expect GovernanceAnchor { voting_stake_hash, .. } = anchor
      when redeemer is {
        OpenProposal { seed_input_index, proposal_output_index, .. } -> {
          // [spec 3.3.3 OpenProposal]: coupled to OpenAction.
          let coupled = coupled_to(voting_stake_hash, redeemers, tag_open)
          // [spec 3.3.3 OpenProposal]: exactly one proposal NFT minted, its name
          //   the blake2b_256 of the consumed seed OutputReference (one-shot).
          expect Some(seed_in) = list.at(inputs, seed_input_index)
          let name = blake2b_256(cbor.serialise(seed_in.output_reference))
          let minted = mints_exactly_one(mint, policy_id, name)
          // [spec 3.3.3 OpenProposal]: the proposal output sits at this script.
          expect Some(prop_out) = list.at(outputs, proposal_output_index)
          let at_own = prop_out.address.payment_credential == Script(policy_id)
          and {
            coupled?,
            minted?,
            at_own?,
          }
        }
        CastVote { .. } -> {
          // [spec 3.3.3 CastVote]: coupled to CastAction; exactly one receipt.
          let coupled = coupled_to(voting_stake_hash, redeemers, tag_cast)
          and {
            coupled?,
            one_under_policy(mint, policy_id, 1)?,
          }
        }
        ExecuteProposal { .. } -> {
          // [spec 3.3.3 ExecuteProposal]: coupled to ExecuteAction; exactly one
          //   decision minted (the voting action pins it to the gate + binding).
          let coupled = coupled_to(voting_stake_hash, redeemers, tag_execute)
          and {
            coupled?,
            one_under_policy(mint, policy_id, 1)?,
          }
        }
        BurnProposal { .. } -> {
          // [spec 3.3.3 BurnProposal]: coupled to a terminal voting action
          //   (Finalize or Expire); exactly one proposal NFT burned.
          let coupled = or {
            coupled_to(voting_stake_hash, redeemers, tag_finalize),
            coupled_to(voting_stake_hash, redeemers, tag_expire),
          }
          and {
            coupled?,
            one_under_policy(mint, policy_id, -1)?,
          }
        }
        // BurnDecision handled above.
        _ -> False
      }
    }
  }
}

// proposal_spend — the shared thin check for every proposal spend.
// ─────────────────────────────────────────────────────────────────────────────
fn proposal_spend(
  voting_hash: ByteArray,
  expected_tag: Int,
  proposal_input_index: Int,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  let Transaction { inputs, redeemers, .. } = self
  // [security]: self-reference — the indexed input is the UTxO being spent,
  //   so the coupled voting action necessarily validates THIS proposal.
  expect Some(prop_in) = list.at(inputs, proposal_input_index)
  let is_own = prop_in.output_reference == own_ref
  let gov_policy = own_policy_of(prop_in.output)
  // [security]: the withdrawal runs the matching voting action.
  let coupled = coupled_to(voting_hash, redeemers, expected_tag)
  // [security]: no double satisfaction — exactly ONE proposal UTxO of this
  //   script is spent. The single withdraw-zero voting action validates one
  //   proposal; batching two would leave the second's transition unchecked.
  let spent_proposals = list.count(
    inputs,
    fn(i) {
      and {
        i.output.address.payment_credential == Script(gov_policy),
        holds_policy(i.output.value, gov_policy),
      }
    },
  )
  and {
    is_own?,
    coupled?,
    (spent_proposals == 1)?,
  }
}

// validate_spend — the dispatcher's spending purpose (anchor + proposals).
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_spend(
  settings_policy: PolicyId,
  datum: GovernanceDatum,
  redeemer: GovSpendRedeemer,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  when redeemer is {
    // [spec 3.3.3 UpdateCharter]: the creator amends mutable charter fields. The
    //   anchor is SPENT here (not referenced), so the charter comes from this
    //   UTxO's own datum. (Amending via a passed ParamChange decision consumed at
    //   the gate is a documented follow-up.)
    UpdateCharter { anchor_input_index, .. } -> {
      expect GovernanceAnchor { creator, .. } = datum
      expect Some(anchor_in) = list.at(self.inputs, anchor_input_index)
      let is_own = anchor_in.output_reference == own_ref
      and {
        is_own?,
        credential_authorized(creator, self)?,
      }
    }
    // Proposal spends read the charter from the anchor REFERENCE input for the
    // published voting hash.
    _ -> {
      let anchor = read_anchor(self.reference_inputs, settings_policy)
      expect GovernanceAnchor { voting_stake_hash, .. } = anchor
      when redeemer is {
        Vote { proposal_input_index, .. } ->
          proposal_spend(
            voting_stake_hash,
            tag_cast,
            proposal_input_index,
            own_ref,
            self,
          )
        Finalize { proposal_input_index, .. } ->
          proposal_spend(
            voting_stake_hash,
            tag_finalize,
            proposal_input_index,
            own_ref,
            self,
          )
        Execute { proposal_input_index, .. } ->
          proposal_spend(
            voting_stake_hash,
            tag_execute,
            proposal_input_index,
            own_ref,
            self,
          )
        Expire { proposal_input_index, .. } ->
          proposal_spend(
            voting_stake_hash,
            tag_expire,
            proposal_input_index,
            own_ref,
            self,
          )
        // UpdateCharter handled above.
        _ -> False
      }
    }
  }
}
