use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{blake2b_256}
use cardano/address.{Script}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, OutputReference, Redeemer, ScriptPurpose, Transaction, Withdraw,
}
use governance/types.{
  BurnDecision, BurnProposal, CastAction, Execute, ExecuteAction,
  ExecuteProposal, Expire, ExpireAction, Finalize, FinalizeAction,
  GovMintRedeemer, GovSpendRedeemer, GovernanceAnchor, GovernanceDatum,
  OpenAction, OpenProposal, RegisterAction, RegisterVoter, RosterSpend,
  UpdateCharter, Vote, VoteRecordSpend, VotingAction,
}
use governance/validation.{
  anchor_name, charter_valid, credential_authorized, is_proposal, is_roster,
  is_voter_record, mints_exactly_one, output_holds_single, own_policy_of,
  read_anchor, spent_of_kind,
}

// VotingAction constructor tags — the coupling contract between the thin
// dispatcher and the withdraw-zero voting validator.
const tag_open: Int = 0

const tag_cast: Int = 1

const tag_finalize: Int = 2

const tag_execute: Int = 3

const tag_expire: Int = 4

const tag_register: Int = 5

fn voting_action_tag(va: VotingAction) -> Int {
  when va is {
    OpenAction { .. } -> tag_open
    CastAction { .. } -> tag_cast
    FinalizeAction { .. } -> tag_finalize
    ExecuteAction { .. } -> tag_execute
    ExpireAction { .. } -> tag_expire
    RegisterAction { .. } -> tag_register
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
        RegisterVoter { .. } -> {
          // [spec 3.3.3 RegisterVoter]: coupled to RegisterAction; exactly one
          //   voter-record token minted (name + record shape validated there).
          let coupled = coupled_to(voting_stake_hash, redeemers, tag_register)
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
  // [security]: no double satisfaction — exactly ONE PROPOSAL UTxO of this
  //   script is spent (counted by datum shape: voter records and the roster
  //   also live at this address). The single withdraw-zero voting action
  //   validates one proposal; batching two would leave the second's transition
  //   unchecked.
  let single_proposal = spent_of_kind(inputs, gov_policy, is_proposal) == 1
  and {
    is_own?,
    coupled?,
    single_proposal?,
  }
}

// validate_spend — the dispatcher's spending purpose (anchor, proposals,
// voter records, roster).
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
    UpdateCharter { anchor_input_index, anchor_output_index } -> {
      expect  
          GovernanceAnchor {
            member_policy,
            creator,
            voting_stake_hash,
            gate_hash,
            ..
          }
        = datum
      expect Some(anchor_in) = list.at(self.inputs, anchor_input_index)
      let is_own = anchor_in.output_reference == own_ref
      // [spec 3.3.3 UpdateCharter]: continuation — the anchor NFT stays at its
      //   address (only ADA + settings policy), no value skimmed.
      expect Some(anchor_out) = list.at(self.outputs, anchor_output_index)
      let anchor_kept = and {
        output_holds_single(anchor_out, settings_policy, anchor_name),
        anchor_out.address == anchor_in.output.address,
        assets.lovelace_of(anchor_out.value) >= assets.lovelace_of(
          anchor_in.output.value,
        ),
      }
      // [spec 3.3.3 UpdateCharter]: the published identity of the instance is
      //   IMMUTABLE — member policy, voting/gate hashes, and the creator itself
      //   can never be amended; the new charter must stay inside the envelope.
      expect InlineDatum(nd) = anchor_out.datum
      expect new_anchor: GovernanceDatum = nd
      expect  
          GovernanceAnchor {
            member_policy: n_member,
            creator: n_creator,
            voting_stake_hash: n_voting,
            gate_hash: n_gate,
            ..
          }
        = new_anchor
      let immutable_kept = and {
        n_member == member_policy,
        n_creator == creator,
        n_voting == voting_stake_hash,
        n_gate == gate_hash,
      }
      and {
        is_own?,
        credential_authorized(creator, self)?,
        anchor_kept?,
        immutable_kept?,
        charter_valid(new_anchor)?,
      }
    }
    // [spec 3.3.3 VoteRecordSpend]: a voter record moves only inside a cast —
    //   the coupled CastAction validates the record transition; exactly one
    //   record is spent, so the validated one is this one.
    VoteRecordSpend { .. } -> {
      let anchor = read_anchor(self.reference_inputs, settings_policy)
      expect GovernanceAnchor { voting_stake_hash, .. } = anchor
      let gov_policy = own_policy_of_input(own_ref, self)
      and {
        coupled_to(voting_stake_hash, self.redeemers, tag_cast)?,
        (spent_of_kind(self.inputs, gov_policy, is_voter_record) == 1)?,
      }
    }
    // [spec 3.3.3 RosterSpend]: the roster moves only inside a registration —
    //   the coupled RegisterAction validates the append; the roster NFT is
    //   one-shot so only one roster can ever be spent.
    RosterSpend { .. } -> {
      let anchor = read_anchor(self.reference_inputs, settings_policy)
      expect GovernanceAnchor { voting_stake_hash, .. } = anchor
      let gov_policy = own_policy_of_input(own_ref, self)
      and {
        coupled_to(voting_stake_hash, self.redeemers, tag_register)?,
        (spent_of_kind(self.inputs, gov_policy, is_roster) == 1)?,
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
        // UpdateCharter / VoteRecordSpend / RosterSpend handled above.
        _ -> False
      }
    }
  }
}

// The policy (script hash) of the UTxO being spent, located by own_ref.
fn own_policy_of_input(own_ref: OutputReference, self: Transaction) -> PolicyId {
  expect Some(own_in) = list.find(
    self.inputs,
    fn(i) { i.output_reference == own_ref },
  )
  own_policy_of(own_in.output)
}
