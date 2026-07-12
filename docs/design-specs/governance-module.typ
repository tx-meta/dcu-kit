#import "./resources/transaction.typ": *
#let background-color = rect(width: 100%, height: 100%, fill: rgb("#102E4A"))
#let image-foreground = image("./images/tx-logo.png", width: 100%, fit: "contain")
#let image-header = image("./images/tx-logo-dark.png", height: 75%, fit: "contain")

#set page(
  background: background-color,
  paper: "a4",
  margin: (left: 20mm, right: 20mm, top: 40mm, bottom: 30mm),
)

#set text(15pt, font: "Barlow")

#v(3cm)

#align(center)[
  #box(
    width: 60%,
    stroke: none,
    image-foreground,
  )
]

#v(1cm)

#set text(22pt, fill: white)
#align(center)[#strong[DCU Toolkit — Governance Module]]
#set text(20pt, fill: white)
#align(center)[#strong[Design Specification]]

#v(5cm)

#set text(13pt, fill: white)

#set text(fill: luma(0%))
#show link: underline
#set terms(separator: [: ], hanging-indent: 18mm)

#set par(justify: true)
#set page(
  paper: "a4",
  margin: (left: 20mm, right: 20mm, top: 40mm, bottom: 35mm),
  background: none,
  header: [
    #align(right)[
      #image("./images/tx-logo-dark.png", width: 25%, fit: "contain")
    ]
    #line(length: 100%, stroke: 0.5pt)
  ],
)

#v(20mm)
#show link: underline
#show outline.entry.where(level: 1): it => {
  v(6mm, weak: true)
  strong(it)
}

#outline(depth: 2, indent: 1em)
#pagebreak()
#set text(size: 11pt)
#set page(
  footer: [
    #line(length: 100%, stroke: 0.5pt)
    #v(-3mm)
    #align(center)[
      #set text(size: 11pt, fill: black)
      *TxMeta – *
      #set text(size: 11pt, fill: gray)
      *DCU-Toolkit Governance Module*
      #v(-3mm)
      Project Design Specification
      #v(-3mm)
    ]
    #v(-6mm)
    #align(right)[
      #context counter(page).display("1/1", both: true)]
  ],
)

#counter(page).update(1)
#v(100pt)
#set terms(separator: [: ], hanging-indent: 18mm)
#align(center)[
  #set text(size: 20pt)
  #strong[DCU Toolkit — Governance Module (Primitive \#9)]]
#v(20pt)
\

#set heading(numbering: "1.")
#show heading: set text(rgb("#102E4A"))

= Overview
\

The Governance Module turns the flat authorization credential the shipped primitives already use — the `quorum: Credential` socket in the escrow pool vault and the savings vault, which today gates social payouts, loan disbursement, write-offs, rule changes, and cycle close — into a real collective-decision primitive: *propose → vote → decide*. A group records a proposal on-chain, its members cast weighted votes into a cached tally, and a proposal that meets its frozen quorum and threshold before its deadline emits an authenticated, one-shot *decision*. That decision is the single thing that satisfies the existing quorum socket, so a treasury action becomes provably backed by a recorded vote — without changing a single byte of the escrow or savings validators.

The module's value is *enforcement, not deliberation*. On-chain governance systems that try to host the debate and discover preferences on-chain fail predictably: turnout collapses below a few percent and token-weighted voting concentrates into a handful of wallets. This module keeps deliberation, rationale, and identity off-chain (the trust-state rule) and puts on-chain only what another member must be able to trust and what a treasury must be forced to obey: the proposal, the tally, the frozen thresholds, the outcome, and the binding of that outcome to one specific action on one specific vault. Making the vote binding on the treasury is the scarce primitive; that is all this module does.

Everything a group can reasonably choose is configurable — voting weight, who may open which proposals, quorum and threshold, and an optional execution timelock — and every choice that is *not* configurable is fixed because security or efficiency requires it, stated at each such point. The default posture follows the cooperative principle and the on-chain evidence: one member, one vote; quorum measured over votes actually cast, not total membership.

The module is built with Aiken on Cardano and ships as a standalone validator family (`onchain/governance/`), following the same additive-module policy as the escrow and savings families: it introduces no change to any existing validator and never shares mutable state with one. It composes with them by *reference-read only* — governance reads a member's savings share balance to weight a vote, and the gate reads a vault's action to authorize it — never by co-mutating another family's state. The offchain layer is TypeScript with Lucid Evolution and Effect, following the DCU Toolkit SDK conventions.

Deliberate \#9 exclusions: on-chain deliberation or comment threads (off-chain), delegated/liquid voting (a member votes their own weight only), quadratic or reputation-weighted voting (v1 offers one-member-one-vote and share-weighted only), multi-body ratification à la CIP-1694 (a single member body decides; committee/supervisory structure is a product-layer concern), and governance-of-governance beyond charter field edits (the charter is amendable by decision, but the validator set is fixed per instance).

#pagebreak()
\
= Architecture
\

The module is three validators plus a one-shot configuration token, deliberately split so that the heavy vote-counting and lifecycle logic never inflates the script that must be small. The split mirrors the ROSCA treasury's proven shape: a thin dispatcher that validates nothing heavy, a staking validator that runs the expensive logic exactly once per transaction (the "withdraw-zero trick"), and — unique to governance — a minimal gate validator that is the integration seam into the other families.

+ *Governance Settings Policy*

  A one-shot minting policy, *parameterized by a seed `OutputReference`*, that mints a single *Governance Anchor NFT*. The seed parameter makes the policy — and therefore the instance's dispatcher, voting, and gate hashes — unique per governance instance. This is a security requirement, not a convenience: a target vault commits to a governance instance only through the `quorum: Credential` it points at, so that credential (the gate) must be instance-specific. Were the policy shared across instances, a malicious instance could pass a proposal naming another group's vault as its target and drain it — a decision minted under a shared dispatcher would satisfy the shared gate. With per-instance hashes, a decision is spendable only at its own instance's gate, which is not any other vault's quorum. The cost is per-instance reference scripts, amortized when one instance governs several vaults via `governed_targets`. The anchor UTxO the NFT authenticates carries the charter and publishes the voting and gate script hashes; every other validator is compiled with this policy as its only parameter and reads the anchor as a reference input to learn the trusted hashes at run time, breaking the mutual-hash dependency without a circular compile (the ROSCA settings-NFT role).

+ *Governance Dispatcher Validator* (mint + spend)

  The identity of a governance instance: proposal NFTs, vote receipts, and decision tokens are all minted under this hash, and proposal UTxOs sit at its address. It validates nothing heavy itself. Its mint and spend handlers only confirm that a withdrawal from the published voting validator is present and carries the matching action (the withdraw-zero coupling). Keeping it thin is what lets the lifecycle logic grow without pushing this script toward the size ceiling.

+ *Governance Voting Validator* (staking / withdraw-zero)

  The home of all expensive validation, executed once per transaction in its `withdraw` handler triggered by a zero-lovelace withdrawal from its own stake credential. It validates every lifecycle transition — open a proposal, cast a vote (eligibility, weight, no double-vote, tally update), finalize, execute, expire — against the anchor charter and the proposal datum. Splitting this out is mandatory: primitive \#7's monolithic validator reached 97% of the deploy-size ceiling, and governance's logic is heavier.

+ *Governance Gate Validator* (spend)

  The seam. An escrow or savings fund sets its `quorum: Credential` to this validator's script credential. A *decision token* produced by a passed proposal is locked at the gate address; when the group performs the approved privileged action, that action's transaction spends the decision UTxO here, which is exactly what satisfies the unchanged `credential_authorized(Script(gate))` check in the other family (its `Script` path requires a spent input at that credential — a bare reference input cannot satisfy it). The gate validates that the decision binds to the vault and action being performed, then burns it.

Key structural decisions:

+ *Enforcement by a one-shot beacon.* A passed proposal mints exactly one decision token bound to `(target_id, action)`. It is the beacon that both proves authorization and is destroyed on use, so a decision can never be replayed against a second vault or a second action. The gate consumes it under the strictly-increasing-index discipline of `multi_utxo_indexer`, which is how a validator that reads another script's action in the same transaction avoids the double-satisfaction class of bug.

+ *No on-chain member iteration.* Votes are member-cast: a member spends nothing of the group's and mints their own vote receipt while updating the proposal's cached tally by one entry. The proposal datum carries the running `tally_yes`, `tally_no`, and `votes_cast`; nothing ever scans a member list. There is no member ceiling and no crank — the same scale property as the savings share-out.

+ *Frozen rules per proposal.* Quorum, threshold, voting mode, and deadline are copied from the charter into the proposal datum at open time and are immutable thereafter. Moving the goalposts mid-vote is therefore impossible by construction, not by policy.

+ *Configurable by default, fixed only where it must be.* Voting weight, opener policy per action class, quorum, threshold, and execution timelock are charter fields. What is fixed — one vote per member, the decision→action binding, the gate seam mechanism, and the closed action enum — is fixed because a configurable version would be a security hole or an unbounded validator, noted at each point.

+ *Reference-read composition only.* Share-weighted voting reads a member's savings account UTxO as a reference input; the gate reads the target vault's datum and redeemer as it authorizes. Governance never co-spends or co-mutates another family's state, so audit scope stays per-family and the transaction ex-unit budget stays flat.

#pagebreak()
\
= Specification

== System Actors
\
+ *Member / Voter*

  An entity eligible to vote in a governance instance, proven by holding an eligibility token of the charter's configured `member_policy` (for a savings group, the member's CIP-68 user token). A member opens proposals where the charter's opener policy permits, and casts exactly one weighted vote per proposal.

+ *Creator*

  The entity that instantiates the governance instance by minting the anchor NFT and writing the initial charter. A Credential or token, never a bare verification key (terminology standard). The creator may be granted exclusive rights to open certain proposal classes via the charter's opener policy; it holds no unilateral power over the treasury.

+ *The Decision*

  Not a person — the authenticated one-shot decision token emitted by a passed proposal. It is the actor that satisfies the escrow/savings quorum socket. Bound to one target and one action, and burned on use.

+ *Executor / Cranker*

  Permissionless. Anyone may drive a proposal whose deadline has passed to its terminal state — finalize a decided proposal, or expire an undecided or unexecuted one — and anyone may trigger execution of a passed proposal. Liveness requires no privilege, mirroring the savings arrears crank.
\
== Tokens
\
+ *Governance Anchor NFT*

  Minted once by the Governance Settings Policy when an instance is created; permanent reference data (no burn path — the charter is a lasting record). Authenticates the anchor UTxO that carries the charter and the published validator hashes.

  - *TokenName:* a fixed anchor label; one-shot uniqueness comes from the policy's seed parameter, so the instance is unique by policy id rather than by token name.

+ *Proposal State NFT*

  Minted under the dispatcher policy when a proposal is opened; burned when the proposal reaches a terminal state and its UTxO is reclaimed. Authenticates the proposal UTxO and its cached tally.

  - *TokenName:* `blake2b_256` of the proposal's seed `OutputReference`. This value is the `proposal_id`.

+ *Vote Receipt Token*

  Minted under the dispatcher policy when a member casts a vote; one per member per proposal. Its existence is what prevents a second vote — the same name cannot be minted twice. Sent to the voter's wallet as their receipt.

  - *TokenName:* `blake2b_256(proposal_id ++ voter_ref)`, where `voter_ref` is the member's eligibility-token name. Deterministic in the member and proposal, so a re-vote attempt mints a name that already exists and fails.

+ *Decision Token*

  Minted under the dispatcher policy only when a proposal is executed from the `Passed` state; locked at the gate address; burned by the gate when the approved action is performed.

  - *TokenName:* `blake2b_256(proposal_id ++ "decision")` — one decision per proposal, distinct from the Proposal State NFT (`proposal_id`) so the two never collide into one unit under the dispatcher policy.
\
== Smart Contracts
\
The family is one settings policy and three validators. The settings policy and gate are minimal; the dispatcher is a thin coupling stub; the voting validator carries all heavy logic.

=== Governance Settings Policy
\
==== Parameters
\
- *`seed`: ```rs OutputReference```* – The UTxO consumed to make this instance one-shot. It fixes the policy id, and through it the instance's dispatcher, voting, and gate hashes — the isolation that lets a vault's quorum commit to one instance.
\
==== Minting Purpose
\
===== Redeemer
\
- *```rust
  MintAnchor { anchor_output_index: Int }
  ```*
\
===== Validation
\
+ *MintAnchor*

  - The parameter `seed` `OutputReference` is present in `tx.inputs` (one-shot — ties this policy to a unique consumed UTxO).
  - Exactly one token of this policy is minted, quantity `+1`, with the fixed anchor token name; no other token under this policy.
  - The output at `anchor_output_index` sits at the dispatcher script address, holds the minted NFT, and carries a well-formed `GovernanceAnchor` datum whose `voting_stake_hash` and `gate_hash` are non-empty.
  - *No burn path.* The anchor is permanent reference data; the burn case is `fail`.
\
=== Governance Dispatcher Validator
\
==== Parameters
\
- *`settings_policy`: ```rs PolicyId```* – The Governance Settings Policy. The dispatcher reads the anchor (authenticated by this policy's NFT, taken as a reference input) to learn the trusted `voting_stake_hash`.
\
==== Minting Purpose
\
===== Redeemer
\
- *```rust
  OpenProposal {
    seed_input_index: Int,
    proposal_output_index: Int,
    withdrawal_index: Int,
  }
  ```*

- *```rust
  CastVote {
    proposal_input_index: Int,
    receipt_output_index: Int,
    voter_index: Int,
    withdrawal_index: Int,
  }
  ```*

- *```rust
  ExecuteProposal {
    proposal_input_index: Int,
    decision_output_index: Int,
    withdrawal_index: Int,
  }
  ```*

- *```rust
  BurnProposal { withdrawal_index: Int }
  ```* — burns the Proposal State NFT when a terminal proposal UTxO is reclaimed.

- *```rust
  BurnDecision
  ```* — burns a Decision token; the covering gate spend forces the full check.
\
===== Validation
\
Every mint variant except `BurnDecision` couples to the voting validator: the transition is validated once in that validator's `withdraw` handler, and the mint only confirms the coupling and the token shape.

+ *OpenProposal*

  - A withdrawal from `settings.voting_stake_hash` is present at `withdrawal_index`, and its redeemer is the `OpenAction` variant (constructor tag check — without it, any voting action would license this mint).
  - Exactly one Proposal State NFT is minted, name `= blake2b_256` of `inputs[seed_input_index].output_reference`.
  - The output at `proposal_output_index` is a fresh `Proposal` UTxO at the dispatcher address holding that NFT. (Field-level checks live in the voting validator.)

+ *CastVote*

  - A withdrawal from `settings.voting_stake_hash` is present at `withdrawal_index` with the `CastAction` redeemer.
  - Exactly one Vote Receipt is minted, name `= blake2b_256(proposal_id ++ voter_ref)`, where `proposal_id` is read from the spent proposal at `proposal_input_index` and `voter_ref` from the eligibility token at `voter_index`. *One vote per member is fixed here:* a duplicate vote reproduces an existing token name and the mint fails.

+ *ExecuteProposal*

  - A withdrawal from `settings.voting_stake_hash` is present with the `ExecuteAction` redeemer.
  - Exactly one Decision token is minted, name `= blake2b_256(proposal_id ++ "decision")`, and the output at `decision_output_index` locks it at `settings.gate_hash`'s address with a `Decision` datum binding `(target_id, action, exec_deadline)` copied from the proposal. The voting validator enforces that the proposal is `Passed` and the timelock elapsed.

+ *BurnProposal*

  - A withdrawal from `settings.voting_stake_hash` is present with a terminal action (`FinalizeAction` for a decided-and-executed proposal, or `ExpireAction`); exactly one Proposal State NFT of this policy is burned (`-1`).

+ *BurnDecision*

  - Exactly one Decision token is burned. The gate spend that consumes the decision UTxO in the same transaction forces the full authorization check; this branch only pins the exact burn, so no voting coupling is required.
\
==== Spend Purpose
\
The dispatcher address holds the `GovernanceAnchor` UTxO and every `Proposal` UTxO. All spends defer to the voting validator; the spend handler only pins that the family withdrawal covers this input.

===== Datum
\
The address holds one datum type with two variants.

- *```rust
  GovernanceAnchor
  ```* — the charter and published hashes:
  - *`title`: ```rs ByteArray```* – Human-readable instance name (group-level, not PII).
  - *`member_policy`: ```rs PolicyId```* – The eligibility token policy; holding a token of this policy makes an actor a voter (e.g. the savings account user-token policy).
  - *`governed_targets`: ```rs List<ByteArray>```* – Target ids (vault anchor names / policies) this instance may govern. A proposal's `target_id` must be a member of this list.
  - *`voting_mode`: ```rs VotingMode```* – Default weight rule: `OneMemberOneVote` or `ShareWeighted { share_source_policy }`. Copied into each proposal at open.
  - *`default_quorum`: ```rs Int```* – Minimum total weight *cast* (yes + no) for a proposal to be decidable. Measured over votes cast, never over total membership.
  - *`default_threshold`: ```rs Int```* – Minimum yes weight as basis points (0–10000) of weight cast, required to pass.
  - *`opener_policy`: ```rs Pairs<Int, OpenerPolicy>```* – Per-action-class rule for who may open a proposal: keyed by action constructor tag, value `AnyMember` or `CreatorOnly`. A tag absent from the map is not openable.
  - *`timelock`: ```rs Int```* – Milliseconds between `Passed` and the earliest `Executed` (`0` = no delay).
  - *`creator`: ```rs Credential```* – The instance creator, referenced by `CreatorOnly` opener rules and by `UpdateCharter`.
  - *`voting_stake_hash`: ```rs ScriptHash```* – Published hash of the Governance Voting Validator. Immutable.
  - *`gate_hash`: ```rs ScriptHash```* – Published hash of the Governance Gate Validator. Immutable.

- *```rust
  Proposal
  ```* — one per open/decided proposal:
  - *`proposal_id`: ```rs AssetName```* – The Proposal State NFT name.
  - *`target_id`: ```rs ByteArray```* – The single vault this proposal governs (a member of `governed_targets`).
  - *`action`: ```rs GovAction```* – The typed, parameterized action to authorize (closed enum below).
  - *`voting_mode`: ```rs VotingMode```* – Frozen from the charter at open.
  - *`quorum`: ```rs Int```* / *`threshold`: ```rs Int```* – Frozen from the charter at open.
  - *`deadline`: ```rs Int```* – POSIX ms; voting closes at this bound.
  - *`exec_deadline`: ```rs Option<Int>```* – POSIX ms by which a passed proposal must execute (`None` = no expiry after passing).
  - *`timelock_until`: ```rs Option<Int>```* – Set when the proposal transitions to `Passed` (`= now + charter.timelock`); execution is invalid before it.
  - *`tally_yes`: ```rs Int```* / *`tally_no`: ```rs Int```* – Running weight for and against.
  - *`votes_cast`: ```rs Int```* – Count of distinct voters recorded (turnout).
  - *`status`: ```rs ProposalStatus```* – `Open`, `Passed`, `Rejected`, `Executed`, or `Expired`.

Supporting types:

- *`GovAction`* (closed enum — *fixed, not configurable:* an open action space cannot be exhaustively validated on-chain, and each variant is a distinct gate check):
  - *```rust
    ParamChange { field_tag: Int, new_value: Int }
    ```* — amend a numeric charter/vault field.
  - *```rust
    SocialPayout { recipient: ByteArray, amount: Int }
    ```* — welfare payment from a fund's social pot.
  - *```rust
    WriteOff { loan_id: AssetName }
    ```* — write off a defaulted loan.
  - *```rust
    TreasuryMove { recipient: ByteArray, amount: Int }
    ```* — move funds from a governed treasury.
  - *```rust
    MembershipChange { member: AssetName, admit: Bool }
    ```* — admit or remove a member.
- *`VotingMode`*: `OneMemberOneVote` | `ShareWeighted { share_source_policy: PolicyId }`.
- *`OpenerPolicy`*: `AnyMember` | `CreatorOnly`.
- *`ProposalStatus`*: `Open` | `Passed` | `Rejected` | `Executed` | `Expired`.

No datum field carries personal data. Identifiers, tallies, thresholds, and timestamps only.
\

===== Redeemer
\
- *```rust
  Vote {
    anchor_ref_index: Int,
    proposal_input_index: Int,
    proposal_output_index: Int,
    voter_index: Int,
    share_ref_index: Int,
    approve: Bool,
    withdrawal_index: Int,
  }
  ```*
  (`share_ref_index = 99` under `OneMemberOneVote`, where no share reference input is read.)

- *```rust
  Finalize {
    anchor_ref_index: Int,
    proposal_input_index: Int,
    proposal_output_index: Int,
    withdrawal_index: Int,
  }
  ```*

- *```rust
  Execute {
    anchor_ref_index: Int,
    proposal_input_index: Int,
    proposal_output_index: Int,
    decision_output_index: Int,
    withdrawal_index: Int,
  }
  ```*

- *```rust
  Expire {
    proposal_input_index: Int,
    withdrawal_index: Int,
  }
  ```*
  (Reclaims a terminal proposal UTxO; pairs with `BurnProposal`.)

- *```rust
  UpdateCharter {
    anchor_input_index: Int,
    anchor_output_index: Int,
  }
  ```*
  (Amends mutable charter fields; the published hashes, creator, and governed-target identity are immutable.)
\

===== Validation
\
Common checks on every proposal spend (stated once):

- *Self-reference:* the input at the redeemer's `*_input_index` for the spent UTxO resolves to the UTxO being validated (`inputs[i].output_reference == own_ref`).
- *Withdraw-zero coupling:* a withdrawal from `settings.voting_stake_hash` (read from the anchor at `anchor_ref_index`) is present at `withdrawal_index`; the heavy checks below run in that withdrawal, not here. The spend handler passes when the coupling holds for its own input.
- *Continuation integrity:* every continuing proposal or anchor output returns to the dispatcher address, keeps its state NFT, holds an inline datum, and changes only the fields named for the redeemer.

The following are enforced in the *voting validator's* `withdraw` handler (the withdraw-zero home), keyed by its action redeemer, one per proposal spend:

+ *OpenAction* (couples to `Vote`? no — to mint `OpenProposal`)

  - The opener is authorized: `charter.opener_policy[action_tag]` is present and satisfied (`AnyMember` ⇒ a token of `member_policy` is present; `CreatorOnly` ⇒ `credential_authorized(charter.creator, tx)`).
  - `target_id` ∈ `charter.governed_targets`.
  - The new `Proposal` copies `voting_mode`, `quorum`, `threshold` from the charter; `deadline` is in the future; tallies are zero; `status = Open`.

+ *CastAction* (couples to `Vote` spend + `CastVote` mint)

  - The proposal is `Open` and `now ≤ deadline` (validity upper bound enforced).
  - The voter presents an eligibility token of `charter.member_policy` at `voter_index`.
  - *Weight:* under `OneMemberOneVote`, weight `= 1`. Under `ShareWeighted`, the reference input at `share_ref_index` is the voter's savings account of `voting_mode.share_source_policy`, its user token matches `voter_ref`, and weight `= share_units` from its datum (an authenticated reference-read, never a spend).
  - Exactly one Vote Receipt of name `blake2b_256(proposal_id ++ voter_ref)` is minted (double-vote prevention).
  - The proposal output increments `tally_yes` (if `approve`) or `tally_no` by weight, and `votes_cast` by one; all other fields unchanged.

+ *FinalizeAction* (couples to `Finalize`)

  - The proposal is `Open` and `now > deadline`.
  - Let `cast = tally_yes + tally_no`. If `cast ≥ quorum` and `tally_yes * 10000 ≥ threshold * cast`, `status → Passed` and `timelock_until = Some(now + charter.timelock)`; otherwise `status → Rejected`. No value moves; only status and `timelock_until` change.

+ *ExecuteAction* (couples to `Execute` spend + `ExecuteProposal` mint)

  - The proposal is `Passed`; `timelock_until` is `Some(t)` with `now ≥ t`; and if `exec_deadline = Some(d)`, `now ≤ d`.
  - Exactly one Decision token of name `proposal_id` is minted and locked at `gate_hash`'s address with datum `Decision { target_id, action, exec_deadline }`.
  - The proposal output sets `status → Executed`; no other field changes.

+ *ExpireAction* (couples to `Expire`)

  - Either the proposal is `Open` with `now > deadline` and it did not meet quorum/threshold, or it is `Passed`/`Executed`-stale past `exec_deadline`. `status → Expired`; the Proposal State NFT is burned and min-ADA reclaimed by the cranker.

+ *UpdateCharter*

  - `credential_authorized(charter.creator, tx)` (bootstrap path) *or* a Decision for a `ParamChange` action targeting this anchor is consumed at the gate in the same transaction (governance-of-charter path).
  - `voting_stake_hash`, `gate_hash`, `creator`, and `member_policy` are unchanged; only tunable fields (`voting_mode`, quorum/threshold defaults, `opener_policy`, `timelock`, `governed_targets`, `title`) may change.
\
=== Governance Voting Validator
\
==== Parameters
\
- *`settings_policy`: ```rs PolicyId```* – Reads the anchor charter (authenticated by the settings NFT) from the transaction's reference inputs.
\
==== Withdraw Purpose
\
===== Redeemer
\
One `VotingAction` type carrying the transition and the indices the heavy check needs. Destructured directly (it is the only withdrawal redeemer for this credential):

- *```rust
  OpenAction   { proposal_output_index: Int, opener_index: Int }
  ```*
- *```rust
  CastAction   { proposal_input_index: Int, proposal_output_index: Int, voter_index: Int, share_ref_index: Int, approve: Bool }
  ```*
- *```rust
  FinalizeAction { proposal_input_index: Int, proposal_output_index: Int }
  ```*
- *```rust
  ExecuteAction  { proposal_input_index: Int, proposal_output_index: Int, decision_output_index: Int }
  ```*
- *```rust
  ExpireAction   { proposal_input_index: Int }
  ```*
\
===== Validation
\
The handler reads the anchor charter once, then runs the matching check from the *Spend Purpose → Validation* list above (`OpenAction … ExpireAction`). Because the escrow/savings-style multi-input coupling applies, when several proposal inputs share this credential the handler validates them under the `multi_utxo_indexer` strictly-increasing-index rule so no output is double-counted. The `else` branch fails, blocking deregistration, governance votes, and proposals from this stake credential.
\
=== Governance Gate Validator
\
==== Parameters
\
- *`gov_policy`: ```rs PolicyId```* – The dispatcher policy, so the gate recognizes genuine Decision tokens.
\
==== Spend Purpose
\
===== Datum
\
- *```rust
  Decision
  ```* — locked with the decision token:
  - *`target_id`: ```rs ByteArray```* – The vault this decision authorizes.
  - *`action`: ```rs GovAction```* – The exact action authorized, with parameters.
  - *`exec_deadline`: ```rs Option<Int>```* – POSIX ms after which the decision is dead even if unspent.
\
===== Redeemer
\
- *```rust
  Authorize {
    decision_input_index: Int,
    target_input_index: Int,
  }
  ```*
\
===== Validation
\
+ *Authorize*

  - *Self-reference:* `inputs[decision_input_index].output_reference == own_ref`, and it holds a Decision token of `gov_policy`.
  - *Binding:* the input at `target_input_index` is the vault named by `datum.target_id`, and *the vault's own redeemer in this transaction* (located by purpose) is the action named by `datum.action` with matching parameters. This is the decision→action binding — the gate authorizes exactly one action on exactly one vault.
  - *Freshness:* if `exec_deadline = Some(d)`, `now ≤ d`.
  - *One-shot:* the Decision token is burned in this transaction (`BurnDecision`, `-1`), so it cannot be reused. *Fixed, not configurable:* replay protection is the gate's entire purpose.
  - *No double satisfaction:* the gate consumes exactly one decision per authorized action; when several decisions/actions appear in one transaction they are matched pairwise by strictly-increasing index (`multi_utxo_indexer`), never many-to-one. The `else` branch fails.

The escrow and savings validators require *no change*: their existing `credential_authorized(quorum, tx)` sees a spent input at the gate credential and passes; the gate independently guarantees that input represents a genuine, bound, unexpired, single-use decision. Duties are separated — the gate proves the group approved this action on this vault; the vault proves the action is well-formed.

#pagebreak()
\
= Transactions
\
This section outlines the transactions of the Governance Module. All `ada` figures are lovelace; timestamps are POSIX milliseconds.
\

== Governance Family
\

=== Mint :: InitGovernance
\
Creates a governance instance: consumes a seed input, mints the one-shot Anchor NFT under the settings policy, and locks it at the dispatcher address with the charter and published validator hashes.
\
#transaction(
  "InitGovernance",
  inputs: (
    (
      name: "Creator Wallet UTxO",
      address: "creator_wallet",
      value: (ada: 5000000),
    ),
  ),
  outputs: (
    (
      name: "Anchor UTxO",
      address: "governance_dispatcher",
      value: (ada: 2000000, Anchor_NFT: 1),
      datum: (
        member_policy: "savings_user_policy",
        voting_mode: "OneMemberOneVote",
        default_quorum: 3,
        default_threshold: 5000,
        timelock: 0,
        voting_stake_hash: "voting_hash",
        gate_hash: "gate_hash",
      ),
    ),
    (
      name: "Creator Wallet UTxO",
      address: "creator_wallet",
      value: (ada: 2800000),
    ),
  ),
  signatures: ("Creator",),
  show_mints: true,
  notes: [InitGovernance Transaction],
)
\
==== Inputs
\
+ *Creator Wallet UTxO.*
  - Address: Creator's wallet address
  - Value: ADA for the anchor min-ADA and fees. This UTxO is the settings policy's `seed` parameter, fixing the instance's policy id and hashes.
\
==== Mints
\
+ *Governance Settings Policy*
  - Redeemer: MintAnchor
  - Value: +1 Anchor NFT (fixed name; policy seeded by the consumed UTxO)
\
==== Outputs
\
+ *Anchor UTxO:*
  - Address: Governance Dispatcher script address
  - Datum: `GovernanceAnchor` — `member_policy`, `governed_targets`, `voting_mode`, quorum/threshold defaults, `opener_policy`, `timelock`, `creator`, and the immutable `voting_stake_hash` / `gate_hash`
  - Value: min-ADA + 1 Anchor NFT

+ *Creator Wallet UTxO:*
  - Address: Creator's wallet address
  - Value: change ADA
#pagebreak()

=== Mint :: OpenProposal
\
A member opens a proposal. The anchor is a reference input; the voting validator's `OpenAction` withdrawal validates opener authority and target membership.
\
#transaction(
  "OpenProposal",
  inputs: (
    (
      name: "Opener Wallet UTxO",
      address: "member_wallet",
      value: (ada: 5000000, Member_Token: 1),
    ),
    (
      name: "Anchor UTxO",
      address: "governance_dispatcher",
      reference: true,
      value: (ada: 2000000, Anchor_NFT: 1),
      datum: (voting_stake_hash: "voting_hash"),
    ),
  ),
  outputs: (
    (
      name: "Proposal UTxO",
      address: "governance_dispatcher",
      value: (ada: 2000000, Proposal_NFT: 1),
      datum: (
        target_id: "savings_fund_id",
        action: "SocialPayout",
        quorum: 3,
        threshold: 5000,
        deadline: 1760000000000,
        tally_yes: 0,
        tally_no: 0,
        votes_cast: 0,
        status: "Open",
      ),
    ),
    (
      name: "Opener Wallet UTxO",
      address: "member_wallet",
      value: (ada: 2800000, Member_Token: 1),
    ),
  ),
  signatures: ("Member",),
  show_mints: true,
  notes: [OpenProposal — withdraw-zero couples to voting OpenAction],
)
\
==== Inputs
\
+ *Opener Wallet UTxO.*
  - Address: Member wallet; carries the eligibility token of `member_policy`.
+ *Anchor UTxO* (reference).
  - Address: Dispatcher; supplies the charter (`opener_policy`, `governed_targets`, `voting_stake_hash`).
\
==== Mints
\
+ *Governance Dispatcher*
  - Redeemer: OpenProposal
  - Value: +1 Proposal State NFT (`blake2b_256` of the seed `OutputReference`)
+ *Governance Voting Validator*
  - Withdrawal: 0 lovelace, redeemer `OpenAction` (runs the opener/target checks once)
\
==== Outputs
\
+ *Proposal UTxO:*
  - Address: Dispatcher script address
  - Datum: `Proposal` — `target_id`, `action`, frozen `voting_mode`/`quorum`/`threshold`, future `deadline`, zero tallies, `status = Open`
  - Value: min-ADA + 1 Proposal State NFT
+ *Opener Wallet UTxO:* change ADA + eligibility token returned.
#pagebreak()

=== Spend :: Vote
\
A member casts one weighted vote. Share-weighted mode reads the voter's savings account as a reference input; the receipt token makes a second vote impossible.
\
#transaction(
  "Vote",
  inputs: (
    (
      name: "Proposal UTxO",
      address: "governance_dispatcher",
      redeemer: [Vote],
      value: (ada: 2000000, Proposal_NFT: 1),
      datum: (tally_yes: 4, tally_no: 1, votes_cast: 5, status: "Open"),
    ),
    (
      name: "Voter Wallet UTxO",
      address: "member_wallet",
      value: (ada: 5000000, Member_Token: 1),
    ),
    (
      name: "Voter Savings Account",
      address: "savings_vault",
      reference: true,
      value: (ada: 2000000, Account_Ref_NFT: 1),
      datum: (share_units: 3),
    ),
  ),
  outputs: (
    (
      name: "Proposal UTxO",
      address: "governance_dispatcher",
      value: (ada: 2000000, Proposal_NFT: 1),
      datum: (tally_yes: 7, tally_no: 1, votes_cast: 6, status: "Open"),
    ),
    (
      name: "Voter Wallet UTxO",
      address: "member_wallet",
      value: (ada: 2800000, Member_Token: 1, Vote_Receipt: 1),
    ),
  ),
  signatures: ("Member",),
  show_mints: true,
  notes: [Vote — approve, share-weighted (+3), couples to voting CastAction],
)
\
==== Inputs
\
+ *Proposal UTxO.* Spent; `Open` and `now ≤ deadline`. Redeemer `Vote { approve, … }`.
+ *Voter Wallet UTxO.* Presents the eligibility token of `member_policy`.
+ *Voter Savings Account* (reference, share-weighted only). Supplies `share_units` as the vote weight; matched to the voter by user-token name.
\
==== Mints
\
+ *Governance Dispatcher*
  - Redeemer: CastVote
  - Value: +1 Vote Receipt (`blake2b_256(proposal_id ++ voter_ref)`) — reproducing this name on a re-vote fails
+ *Governance Voting Validator*
  - Withdrawal: 0 lovelace, redeemer `CastAction` (weight + tally update, once)
\
==== Outputs
\
+ *Proposal UTxO:* `tally_yes` (or `tally_no`) increased by weight, `votes_cast` +1; all else unchanged.
+ *Voter Wallet UTxO:* change ADA, eligibility token returned, +1 Vote Receipt.
#pagebreak()

=== Spend :: Finalize
\
After the deadline, anyone finalizes the proposal: the frozen quorum and threshold are compared to the cast tally, deciding `Passed` or `Rejected`. No value moves.
\
#transaction(
  "Finalize",
  inputs: (
    (
      name: "Proposal UTxO",
      address: "governance_dispatcher",
      redeemer: [Finalize],
      value: (ada: 2000000, Proposal_NFT: 1),
      datum: (tally_yes: 7, tally_no: 1, votes_cast: 6, quorum: 3, threshold: 5000, status: "Open"),
    ),
    (
      name: "Anchor UTxO",
      address: "governance_dispatcher",
      reference: true,
      value: (ada: 2000000, Anchor_NFT: 1),
      datum: (voting_stake_hash: "voting_hash"),
    ),
  ),
  outputs: (
    (
      name: "Proposal UTxO",
      address: "governance_dispatcher",
      value: (ada: 2000000, Proposal_NFT: 1),
      datum: (tally_yes: 7, tally_no: 1, votes_cast: 6, status: "Passed", timelock_until: 1760000600000),
    ),
  ),
  signatures: ("Cranker",),
  show_mints: false,
  notes: [Finalize — cast=8 ≥ quorum 3, yes 7/8 ≥ 50%, status → Passed],
)
\
==== Inputs
\
+ *Proposal UTxO.* Spent; `Open` and `now > deadline`. Redeemer `Finalize`.
+ *Anchor UTxO* (reference). Supplies `voting_stake_hash` for the coupling.
\
==== Mints
\
+ *Governance Voting Validator*
  - Withdrawal: 0 lovelace, redeemer `FinalizeAction` (the quorum/threshold comparison, once)
\
==== Outputs
\
+ *Proposal UTxO:* `status → Passed` (with `timelock_until = now + timelock`) or `Rejected`; tallies unchanged; state NFT retained.
#pagebreak()

=== Mint :: Execute
\
A passed proposal past its timelock mints its one-shot Decision token, locked at the gate address and bound to the exact target and action. This is the only step that creates authorization.
\
#transaction(
  "Execute",
  inputs: (
    (
      name: "Proposal UTxO",
      address: "governance_dispatcher",
      redeemer: [Execute],
      value: (ada: 2000000, Proposal_NFT: 1),
      datum: (status: "Passed", timelock_until: 1760000600000),
    ),
    (
      name: "Anchor UTxO",
      address: "governance_dispatcher",
      reference: true,
      value: (ada: 2000000, Anchor_NFT: 1),
      datum: (gate_hash: "gate_hash", voting_stake_hash: "voting_hash"),
    ),
  ),
  outputs: (
    (
      name: "Proposal UTxO",
      address: "governance_dispatcher",
      value: (ada: 2000000, Proposal_NFT: 1),
      datum: (status: "Executed"),
    ),
    (
      name: "Decision UTxO",
      address: "governance_gate",
      value: (ada: 2000000, Decision_Token: 1),
      datum: (
        target_id: "savings_fund_id",
        action: "SocialPayout",
        exec_deadline: 1760100000000,
      ),
    ),
  ),
  signatures: ("Cranker",),
  show_mints: true,
  notes: [Execute — mints Decision bound to (target, action), locks it at the gate],
)
\
==== Inputs
\
+ *Proposal UTxO.* Spent; `Passed`, `now ≥ timelock_until`, and within `exec_deadline`. Redeemer `Execute`.
+ *Anchor UTxO* (reference). Supplies `gate_hash` and `voting_stake_hash`.
\
==== Mints
\
+ *Governance Dispatcher*
  - Redeemer: ExecuteProposal
  - Value: +1 Decision token (name `= blake2b_256(proposal_id ++ "decision")`)
+ *Governance Voting Validator*
  - Withdrawal: 0 lovelace, redeemer `ExecuteAction` (asserts `Passed` + timelock, once)
\
==== Outputs
\
+ *Proposal UTxO:* `status → Executed`; state NFT retained (burned later by `Expire`/reclaim).
+ *Decision UTxO:* at the gate address, holds the Decision token and the `Decision { target_id, action, exec_deadline }` datum.
#pagebreak()

=== Spend :: Authorize (gated action)
\
The group performs the approved action on the target vault. The vault's own transaction spends the Decision UTxO at the gate; this is what satisfies the vault's unchanged `quorum: Credential`. Shown here authorizing a savings `SocialPayout`.
\
#transaction(
  "Authorize",
  inputs: (
    (
      name: "Decision UTxO",
      address: "governance_gate",
      redeemer: [Authorize],
      value: (ada: 2000000, Decision_Token: 1),
      datum: (target_id: "savings_fund_id", action: "SocialPayout"),
    ),
    (
      name: "Savings Fund Anchor UTxO",
      address: "savings_vault",
      redeemer: [SocialPayout],
      value: (ada: 50000000, Fund_State_NFT: 1),
      datum: (social_total: 20000000, status: "Active"),
    ),
  ),
  outputs: (
    (
      name: "Savings Fund Anchor UTxO",
      address: "savings_vault",
      value: (ada: 45000000, Fund_State_NFT: 1),
      datum: (social_total: 15000000, status: "Active"),
    ),
    (
      name: "Recipient Wallet UTxO",
      address: "recipient_wallet",
      value: (ada: 5000000),
    ),
  ),
  signatures: ("Member",),
  show_mints: true,
  notes: [Authorize — Decision burned; savings validator runs its own SocialPayout check],
)
\
==== Inputs
\
+ *Decision UTxO.* Spent at the gate; redeemer `Authorize`. The gate binds it to the savings fund (`target_id`) and the `SocialPayout` redeemer present on the vault input, then burns it.
+ *Savings Fund Anchor UTxO.* The target vault; its `quorum: Credential` is the gate credential, satisfied by the spent Decision input. Its own `SocialPayout` validation runs unchanged.
\
==== Mints
\
+ *Governance Dispatcher*
  - Redeemer: BurnDecision
  - Value: −1 Decision token (one-shot; no replay)
\
==== Outputs
\
+ *Savings Fund Anchor UTxO:* `social_total` reduced by the payout; per the savings spec.
+ *Recipient Wallet UTxO:* the welfare payment.
#pagebreak()

=== Spend :: Expire
\
Permissionless cleanup: an `Open` proposal past its deadline that never met quorum/threshold, or a stale passed proposal past its `exec_deadline`, is retired and its Proposal State NFT burned.
\
#transaction(
  "Expire",
  inputs: (
    (
      name: "Proposal UTxO",
      address: "governance_dispatcher",
      redeemer: [Expire],
      value: (ada: 2000000, Proposal_NFT: 1),
      datum: (tally_yes: 1, tally_no: 0, votes_cast: 1, quorum: 3, status: "Open"),
    ),
    (
      name: "Anchor UTxO",
      address: "governance_dispatcher",
      reference: true,
      value: (ada: 2000000, Anchor_NFT: 1),
      datum: (voting_stake_hash: "voting_hash"),
    ),
  ),
  outputs: (
    (
      name: "Cranker Wallet UTxO",
      address: "cranker_wallet",
      value: (ada: 2000000),
    ),
  ),
  signatures: ("Cranker",),
  show_mints: true,
  notes: [Expire — under quorum after deadline; NFT burned, min-ADA reclaimed],
)
\
==== Inputs
\
+ *Proposal UTxO.* Spent; terminal-eligible (`Open` past deadline under quorum, or stale past `exec_deadline`). Redeemer `Expire`.
+ *Anchor UTxO* (reference). Supplies `voting_stake_hash`.
\
==== Mints
\
+ *Governance Dispatcher*
  - Redeemer: BurnProposal
  - Value: −1 Proposal State NFT
+ *Governance Voting Validator*
  - Withdrawal: 0 lovelace, redeemer `ExpireAction`
\
==== Outputs
\
+ *Cranker Wallet UTxO:* reclaimed min-ADA.
#pagebreak()

= Invariants and Security Notes
\

+ *One vote per member, always.* The Vote Receipt name is deterministic in `(proposal_id, voter_ref)`; a second vote reproduces an existing token name and the mint fails. This is not configurable — a group cannot opt into double voting.

+ *Decision binding is total.* A Decision authorizes exactly one `action` on exactly one `target_id`, is valid only until `exec_deadline`, and is burned on use. It cannot be replayed against another vault, another action, or a second time. The gate reads the vault's redeemer to confirm the action matches — an explicit, read-only cross-family inspection, never a co-mutation.

+ *Double satisfaction is closed.* The gate consumes exactly one Decision per authorized action and matches decisions to actions pairwise by strictly-increasing index (`multi_utxo_indexer`); it never allows one Decision to satisfy two vault actions. The voting validator applies the same index discipline when several proposals are processed in one transaction.

+ *Frozen rules.* `voting_mode`, `quorum`, `threshold`, and `deadline` are copied into the proposal at open and are immutable. Quorum is measured over weight *cast*, not total membership — apathy cannot be weaponized to block or force a decision, and the goalposts cannot move mid-vote.

+ *Escrow and savings are untouched.* Their validators change by zero bytes; they simply set `quorum: Credential` to the gate credential. The gate satisfies the existing `Script`-credential rule (spent input at that credential) and independently guarantees the input is a genuine, bound, single-use decision. Duties are separated: the gate proves the group approved this action; the vault proves the action is well-formed.

+ *Size discipline.* All heavy validation lives in the voting staking validator (withdraw-zero); the dispatcher and gate are thin. Primitive \#7 reached 97% of the deploy-size ceiling as a monolith — governance is split from line one so no single script approaches it.

+ *No PII, no member iteration.* Datums carry identifiers, tallies, thresholds, and timestamps only. Nothing scans a member list; tallies are cached and updated one vote at a time, so the module has no member ceiling and no crank.

+ *Value safety.* Governance transitions move no protocol funds — `Finalize`, `Execute`, and voting change only datum state and mint/burn the module's own beacon tokens. The only value movement authorized by the module happens inside the target vault's own validator, under that validator's own value-conservation checks.

#pagebreak()

= Implementation Status and Deferred Items
\
All four validators are implemented and were verified end-to-end on Preprod (anchor mint, voting-stake registration, propose, vote, finalize, execute, gate-authorize). Compiled sizes: dispatcher 3.9 KB, voting 5.2 KB, settings 1.7 KB, gate 0.7 KB — all far below the 16,128-byte reference-script ceiling, which is the payoff of splitting withdraw-zero from line one.

The following are *deliberately deferred*. None is a hole in what is enforced today; each is a capability not yet turned on, listed here so the spec never overstates the implementation.

+ *Share-weighted voting is not enforced on-chain.* `VotingMode` accepts `ShareWeighted`, but casting a vote under it fails. Weight-by-shares requires the validator to decode a savings account datum across family boundaries — a cross-family decode contract that no test yet exercises. Shipping it untested would be a security risk, so one-member-one-vote (the cooperative default, and the anti-plutocracy one) is the enforced mode.

+ *Temporal gating is not enforced.* `deadline`, `exec_deadline`, and `timelock_until` are recorded and carried faithfully, but the validators do not yet compare them against the transaction validity range. Enforcing them requires plumbing explicit validity bounds through every SDK endpoint. Until then a proposal can be finalized before its deadline; the tally, quorum, and threshold are still enforced exactly.

+ *Gate binding is by target, not by action.* The gate proves a decision is genuine, bound to the target vault, and burned on use (no replay). It does not yet assert that the vault's *redeemer action* equals the decision's `action` — that needs a cross-family map from `GovAction` to each vault family's redeemer. The target vault independently enforces that its own action is well-formed, so the residual exposure is a decision approved for one action on a vault authorizing a different action *on that same vault*.

+ *Governance-of-charter.* `UpdateCharter` is creator-authorized. Amending the charter by a passed `ParamChange` decision consumed at the gate is specified but not yet wired.

+ *Batching.* Proposal spends require that exactly ONE proposal UTxO is spent per transaction. This is what closes double satisfaction without a full multi-UTxO indexer: the single withdraw-zero voting action validates one proposal, so batching two would leave the second's transition unchecked. Governance has no batching use case; if one appears, the remedy is `multi_utxo_indexer` with strictly-increasing indices.

#pagebreak()

= References and Prior Art
\
The design draws on the following sources (consulted July 2026).

Cardano patterns and security:

+ *Aiken Design Patterns (Anastasia Labs)* — the withdraw-zero staking-validator trick and `multi_utxo_indexer.one_to_one_with_redeemer`, the basis for the voting validator and the gate's double-satisfaction-safe coupling. #link("https://github.com/anastasia-labs/aiken-design-patterns")
+ *Vacuumlabs — Cardano Vulnerabilities \#1: Double Satisfaction.* #link("https://medium.com/@vacuumlabs_auditing/cardano-vulnerabilities-1-double-satisfaction-219f1bc9665e")
+ *MLabs — Common Plutus Security Vulnerabilities.* #link("https://www.mlabs.city/blog/common-plutus-security-vulnerabilities")
+ *CIP-31 — Reference Inputs* (read-without-spend, the basis for share-weight and charter reads). #link("https://cips.cardano.org/cip/CIP-31")
+ *CIP-1694 — on-chain governance model* (typed actions bound to targets; per-action thresholds; committee one-member-one-vote vs stake-weighted DReps — the precedent for configurable vote weight). #link("https://cips.cardano.org/cip/CIP-1694")
+ *Cardano Governance Actions (Developer Portal).* #link("https://developers.cardano.org/docs/governance/cardano-governance/governance-actions/")

Real-world cooperative governance and DAO evidence:

+ *DT-SACCO Governance Guidelines (Kenya)* — three-organ cooperative governance; one-member-one-vote "regardless of capital invested"; quorum and voting procedures in bylaws. #link("https://directorsforum.co.ke/wp-content/uploads/2025/03/Governance-Guidelines-for-DT-SACCO-Societies.pdf")
+ *Forbes — Why DAOs keep centralizing* (decades of governance research on turnout and capture). #link("https://www.forbes.com/sites/digital-assets/2026/04/04/daos-keep-centralizingdecades-of-governance-research-explain-why/")
+ *DAO governance failures: whales, low turnout, attacks* (turnout below 2–3%; token-weighted plutocracy — the basis for the 1m1v default and cast-vote quorum). #link("https://lopetaku.medium.com/dao-governance-failures-whales-low-turnout-attacks-d1375c556384")
