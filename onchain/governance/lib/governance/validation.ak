use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use governance/types.{
  GovernanceAnchor, GovernanceDatum, Proposal, Roster, VoterRecord,
}

// A UTxO at a governance script address: its payment credential IS that script's
// policy/hash (the dispatcher for proposals, the gate for decisions).
pub fn own_policy_of(output: Output) -> PolicyId {
  expect Script(h) = output.address.payment_credential
  h
}

// The value holds at least one token of `policy`.
pub fn holds_policy(value: Value, policy: PolicyId) -> Bool {
  !list.is_empty(dict.to_pairs(assets.tokens(value, policy)))
}

// Same rule as the escrow/savings quorum socket: a VK credential is satisfied by
// a signature, a Script credential by a spent input at that script.
pub fn credential_authorized(cred: Credential, self: Transaction) -> Bool {
  when cred is {
    VerificationKey(pkh) -> list.has(self.extra_signatories, pkh)
    Script(sh) ->
      list.any(
        self.inputs,
        fn(i) { i.output.address.payment_credential == Script(sh) },
      )
  }
}

// The fixed anchor token name. A per-instance seeded settings policy makes the
// instance unique, so a constant name suffices. Must match the SDK
// (fromText("anchor")).
pub const anchor_name: AssetName = "anchor"

// The fixed roster token name, minted one-shot alongside the anchor. Must match
// the SDK (fromText("roster")).
pub const roster_name: AssetName = "roster"

// [spec 3.3 voter record]: the voter-record token name is DERIVED from the
// member's eligibility-token name, so one member maps to exactly one record
// name and a record can never be presented for a different member.
pub fn voter_record_name(member_id: AssetName) -> AssetName {
  blake2b_256(bytearray.concat("voter", member_id))
}

// [spec 3.3 decision]: the decision token name is DERIVED from the proposal id
// (distinct from the Proposal State NFT so the two never collide), and the
// execute path pins the mint to exactly this name — an unpinned mint would let
// an attacker mint an arbitrary-name token under the dispatcher policy,
// including a duplicate of a live proposal NFT. Must match the SDK
// (blake2b(proposalId ++ fromText("decision"))).
pub fn decision_token_name(proposal_id: AssetName) -> AssetName {
  blake2b_256(bytearray.concat(proposal_id, "decision"))
}

// spent_of_kind
// ─────────────────────────────────────────────────────────────────────────────
// Count the spent dispatcher inputs whose datum decodes to the given
// GovernanceDatum shape — the anti-batch guard for each UTxO kind. The single
// coupled voting action validates ONE transition; a second same-kind input in
// the same tx would ride through unchecked.
pub fn spent_of_kind(
  inputs: List<Input>,
  gov_policy: PolicyId,
  is_kind: fn(GovernanceDatum) -> Bool,
) -> Int {
  list.count(
    inputs,
    fn(i) {
      if i.output.address.payment_credential == Script(gov_policy) {
        when i.output.datum is {
          InlineDatum(d) ->
            if d is gov: GovernanceDatum {
              is_kind(gov)
            } else {
              False
            }
          _ -> False
        }
      } else {
        False
      }
    },
  )
}

pub fn is_proposal(d: GovernanceDatum) -> Bool {
  when d is {
    Proposal { .. } -> True
    _ -> False
  }
}

pub fn is_voter_record(d: GovernanceDatum) -> Bool {
  when d is {
    VoterRecord { .. } -> True
    _ -> False
  }
}

pub fn is_roster(d: GovernanceDatum) -> Bool {
  when d is {
    Roster { .. } -> True
    _ -> False
  }
}

// read_anchor
// ─────────────────────────────────────────────────────────────────────────────
// Locate and parse the instance's anchor from the reference inputs, authenticated
// by the settings NFT (one-shot per instance, so exactly one exists). Fails if
// absent or not the anchor variant. This is the trust anchor every other
// validator reads to learn the published voting/gate hashes and the charter.
pub fn read_anchor(
  reference_inputs: List<Input>,
  settings_policy: PolicyId,
) -> GovernanceDatum {
  expect Some(anchor_input) = list.find(
    reference_inputs,
    fn(i) {
      assets.quantity_of(i.output.value, settings_policy, anchor_name) == 1
    },
  )
  expect InlineDatum(d) = anchor_input.output.datum
  expect gov: GovernanceDatum = d
  expect GovernanceAnchor { .. } = gov
  gov
}

// Exactly one token of `policy` with `name` is minted (+1) and no other token
// under `policy` — the one-shot / single-NFT guard.
pub fn mints_exactly_one(mint: Value, policy: PolicyId, name: AssetName) -> Bool {
  dict.to_pairs(assets.tokens(mint, policy)) == [Pair(name, 1)]
}

// Exactly one token of `policy` with `name` is burned (-1) and no other token
// under `policy`.
pub fn burns_exactly_one(mint: Value, policy: PolicyId, name: AssetName) -> Bool {
  dict.to_pairs(assets.tokens(mint, policy)) == [Pair(name, -1)]
}

// The output holds exactly one token of `policy` with `name`, and its only
// policies are ADA and `policy` (no value stuffing).
pub fn output_holds_single(
  output: Output,
  policy: PolicyId,
  name: AssetName,
) -> Bool {
  and {
    dict.to_pairs(assets.tokens(output.value, policy)) == [Pair(name, 1)],
    assets.policies(output.value) == [assets.ada_policy_id, policy],
  }
}

// charter_valid — the charter invariants (config-safety envelope).
// ─────────────────────────────────────────────────────────────────────────────
// Enforced at mint (validate_mint_anchor) and on every UpdateCharter. A charter
// outside this envelope is a security hole created by configuration: quorum 0
// lets a proposal pass with zero votes, a threshold over 10000 can never pass,
// and a malformed target pair can never be matched by an open.
pub fn charter_valid(anchor: GovernanceDatum) -> Bool {
  expect  
      GovernanceAnchor {
        governed_targets,
        default_quorum,
        default_threshold,
        opener_policy,
        timelock,
        ..
      }
    = anchor
  and {
    // [spec 3.3.2 charter]: at least one vote must be required to decide.
    (default_quorum >= 1)?,
    // [spec 3.3.2 charter]: threshold is basis points of weight cast.
    (default_threshold >= 0 && default_threshold <= 10000)?,
    // [spec 3.3.2 charter]: a negative timelock is meaningless.
    (timelock >= 0)?,
    // [spec 3.3.2 charter]: every governed target is a well-formed
    // (policy, state-NFT name) pair — 28-byte policy, name within ledger bounds.
    list.all(
      governed_targets,
      fn(t) {
        and {
          bytearray.length(t.1st) == 28,
          bytearray.length(t.2nd) <= 32,
        }
      },
    )?,
    // [spec 3.3.2 charter]: opener rules key GovAction constructor tags (0..5;
    //   5 = the Generic forward-compatibility arm).
    list.all(opener_policy, fn(p) { p.1st >= 0 && p.1st <= 5 })?,
  }
}

// validate_mint_anchor — the Governance Settings Policy's MintAnchor logic.
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_mint_anchor(
  seed: OutputReference,
  policy_id: PolicyId,
  anchor_output_index: Int,
  roster_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  // [spec 3.3.2]: one-shot — the seed OutputReference param must be consumed,
  //   tying this policy id to a unique UTxO (instance uniqueness).
  let seed_spent = list.any(inputs, fn(i) { i.output_reference == seed })
  // [spec 3.3.2]: exactly the anchor NFT and the roster NFT are minted under
  //   this policy ("anchor" < "roster" — dict pairs are name-sorted); a burn
  //   fails here, so both are permanent reference data.
  let exact_mint = dict.to_pairs(assets.tokens(mint, policy_id)) == [
    Pair(anchor_name, 1), Pair(roster_name, 1),
  ]
  // [spec 3.3.2]: the anchor output holds the NFT (only ADA + own policy) and a
  //   well-formed GovernanceAnchor datum with non-empty published hashes.
  expect Some(anchor_out) = list.at(outputs, anchor_output_index)
  let holds_anchor = output_holds_single(anchor_out, policy_id, anchor_name)
  expect InlineDatum(d) = anchor_out.datum
  expect gov: GovernanceDatum = d
  expect GovernanceAnchor { voting_stake_hash, gate_hash, .. } = gov
  let hashes_present = voting_stake_hash != #"" && gate_hash != #""
  // [spec 3.3.2 roster]: the roster output holds the roster NFT and starts as
  //   the EMPTY member set — registration is the only append path.
  expect Some(roster_out) = list.at(outputs, roster_output_index)
  let holds_roster = output_holds_single(roster_out, policy_id, roster_name)
  expect InlineDatum(rd) = roster_out.datum
  expect roster: GovernanceDatum = rd
  expect Roster { members } = roster
  and {
    seed_spent?,
    exact_mint?,
    holds_anchor?,
    hashes_present?,
    holds_roster?,
    (members == [])?,
    // [spec 3.3.2 charter]: the charter must be born inside the safety envelope.
    charter_valid(gov)?,
  }
}

// validate_authorize — the Governance Gate's Authorize logic.
// ─────────────────────────────────────────────────────────────────────────────
// The gate is set as a target vault's `quorum: Credential`, so spending a
// decision UTxO here satisfies that vault's unchanged credential check. This
// asserts the decision is genuine, single-use, and bound to the vault. Action-
// level binding (decision.action == the vault's redeemer action) lives in each
// primitive's next version, which decodes the frozen GovAction directly; the
// gate stays semantics-free by design.
pub fn validate_authorize(
  gov_policy: PolicyId,
  target_policy: PolicyId,
  target_id: AssetName,
  decision_input_index: Int,
  target_input_index: Int,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  let Transaction { inputs, mint, .. } = self
  // [security]: self-reference — the indexed input is the decision UTxO spent.
  expect Some(dec_in) = list.at(inputs, decision_input_index)
  let is_own = dec_in.output_reference == own_ref
  // [spec 3.3.5]: the decision token is the single gov_policy token here.
  expect [Pair(dec_name, 1)] = dict.to_pairs(
    assets.tokens(dec_in.output.value, gov_policy),
  )
  // [spec 3.3.5]: one-shot — that decision token is burned this tx (no replay).
  let burned = dict.to_pairs(assets.tokens(mint, gov_policy)) == [
    Pair(dec_name, -1),
  ]
  // [spec 3.3.5]: binding — the target input holds the governed vault's state
  //   NFT under its EXACT (policy, name). A name alone is forgeable: anyone can
  //   mint a same-named token under a permissionless policy (decoy target).
  expect Some(target_in) = list.at(inputs, target_input_index)
  let target_ok = assets.quantity_of(
    target_in.output.value,
    target_policy,
    target_id,
  ) >= 1
  and {
    is_own?,
    burned?,
    target_ok?,
  }
}
