use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use governance/types.{GovernanceAnchor, GovernanceDatum}

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

// validate_mint_anchor — the Governance Settings Policy's MintAnchor logic.
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_mint_anchor(
  seed: OutputReference,
  policy_id: PolicyId,
  anchor_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  // [spec 3.3.2]: one-shot — the seed OutputReference param must be consumed,
  //   tying this policy id to a unique UTxO (instance uniqueness).
  let seed_spent = list.any(inputs, fn(i) { i.output_reference == seed })
  // [spec 3.3.2]: exactly one anchor NFT minted under this policy, correct name;
  //   a burn (-1) fails here, so the anchor is permanent reference data.
  let exact_mint = mints_exactly_one(mint, policy_id, anchor_name)
  // [spec 3.3.2]: the anchor output holds the NFT (only ADA + own policy) and a
  //   well-formed GovernanceAnchor datum with non-empty published hashes.
  expect Some(anchor_out) = list.at(outputs, anchor_output_index)
  let holds_anchor = output_holds_single(anchor_out, policy_id, anchor_name)
  expect InlineDatum(d) = anchor_out.datum
  expect gov: GovernanceDatum = d
  expect GovernanceAnchor { voting_stake_hash, gate_hash, .. } = gov
  let hashes_present = voting_stake_hash != #"" && gate_hash != #""
  and {
    seed_spent?,
    exact_mint?,
    holds_anchor?,
    hashes_present?,
  }
}

// validate_authorize — the Governance Gate's Authorize logic.
// ─────────────────────────────────────────────────────────────────────────────
// The gate is set as a target vault's `quorum: Credential`, so spending a
// decision UTxO here satisfies that vault's unchanged credential check. This
// asserts the decision is genuine, single-use, and bound to the vault. Action-
// level binding (decision.action == the vault's redeemer action) is a documented
// follow-up needing a cross-family action map; the target vault still enforces
// its own action correctness independently.
pub fn validate_authorize(
  gov_policy: PolicyId,
  target_id: ByteArray,
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
  // [spec 3.3.5]: binding — the target input holds a token named target_id (the
  //   governed vault's state NFT), tying the decision to that specific vault.
  expect Some(target_in) = list.at(inputs, target_input_index)
  let target_ok = list.any(
    assets.flatten(target_in.output.value),
    fn(t) { t.2nd == target_id },
  )
  and {
    is_own?,
    burned?,
    target_ok?,
  }
}
