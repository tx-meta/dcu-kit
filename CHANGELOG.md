# Changelog

All notable changes to `@tx-meta/dcu-kit` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to semantic
versioning. Migration steps for every breaking change live in [`MIGRATION.md`](./MIGRATION.md).

## [Unreleased]

## [0.6.1-preprod.0] - 2026-08-10

**Validator hashes changed for ROSCA, savings and governance.** The Preprod
manifest is marked `legacy-validator-set` and stays pinned at `0.6.0-preprod.0`
so existing positions keep operating on the hashes they were created with.
Nothing is deployed on the new hashes yet.

### Fixed

- **ROSCA continuation deadlock (ADR-R1).** Terminating a defaulter whose payout
  slot had not yet passed left pending stand-in cover and a vacant next slot,
  which blocked `DistributeRound` (no borrower) and `BeginRecommit` (pending
  cover) at the same time, with no path back to a running rotation.
  `BeginRecommit` now opens at a provably vacant slot and carries the cover
  across the re-seal.
- **Governance authorized operations, not parameters.** A passed `DisburseLoan`
  decision authorized any borrower for any amount, and `CloseFund` named no
  destination. Each governed savings operation now commits its economic payload
  (ADR-G1), and `CloseFund` routes the entire residual to the committed address.
- `beginRecommit` was missing from `createDcuSession`.
- `resolveUtxoByOutRef` reported provider outages as a missing UTxO.
- `EscrowV2State` omitted `co_beneficiaries`, so a split recipient could not
  discover their own escrow.

### Added

- `BoundIntent` governance action arm, additive: `Generic` and every typed arm
  keep their original encoding.
- Discovery reads: `getGroup`, `listGroups`, `listMembers`, `listMemberships`,
  with cursors, observation slots, a reported query strategy, and diagnostics
  for malformed or unattributable UTxOs.
- Lifecycle eligibility verdicts with reason codes and the out-refs and slot
  they were computed from.
- Portable co-signing bundles bound to network, deployment, validity interval
  and consumed inputs, with cryptographic witness verification.
- Generated reference-script requirements; `distributePayout`, `beginRecommit`
  and `startGroup` now reject a missing reference on live networks instead of
  inlining validator bytes past the transaction-size limit.
- `docs/adr/` with ADR-0001 and ADR-0002.

### Changed

- Every distribution must spend the group's reserve, making the stand-in
  decrement an on-chain invariant rather than an off-chain convention.
- API reference: the `nextCycle` page is removed, DefaultState recovery and the
  error discriminator names are corrected, and nine missing endpoint pages added.

## [0.6.0-preprod.0] - 2026-08-02

**Validator hashes changed for governance and savings.** Both families were
redeployed on Preprod (2026-08-02) and the manifest carries the new references.
ROSCA and escrow blueprints are untouched, so their references and any position
under them are unaffected.

### Added

- `group_type` on the savings fund datum: `0 ASCA, 1 VSLA, 2 Welfare, 3 Pool`,
  constrained at creation and frozen by `updateFund`. `createFund` takes an
  optional `groupType` (default `Asca`); `GroupType` is exported from
  `@tx-meta/dcu-kit/savings`.
- Share-weighted voting is enforced on-chain. A cast under `ShareWeighted` now
  weighs the voter's share units, read from their member account, instead of
  failing. It requires the charter's `share_source_policy` to be the eligibility
  policy, and rejects a voter holding no shares.
- `govActionForOperation` and `SavingsOperation` (governance utils): build a
  decision that authorizes exactly one operation on the governed vault.

### Changed

- **Voters are bound to the fund they vote on.** When the eligibility policy is
  the same policy that identifies the governed vault, one policy covers every
  vault under it, so holding a token proved nothing about which vault. Register
  and cast now reference-read the voter's member account and require its fund to
  be the governed one. `registerVoter` and `castVote` attach that reference
  automatically; the validator finds it by the (100) twin it holds, so no
  reference-input index is involved.
- **A decision is bound to the operation it authorizes.** The gate previously
  discarded the decision's action, so a decision authorizing one operation on a
  vault authorized any operation on it. It now requires the target input's
  redeemer to match what the decision named. Binding is on the redeemer
  constructor by default, because a vault redeemer carries input indices
  resolved at build time and its exact bytes are unknowable when a proposal is
  opened; a `Generic` action with a payload binds the exact bytes instead.
  A target spent with no redeemer performs no action and is rejected.
- A welfare fund that never sold shares can close its cycle with an empty pot,
  once its welfare is fully disbursed, giving it a route to dissolution. The
  SDK's `closeCycle` allows the same case.
- Reference-script deploys select only the inputs they need, preferring ADA-only
  ones. A deploy carries the whole script, and an unbounded wallet selection
  built a 16,645-byte transaction for the same 15.8 KB script that fits in
  16,001 bytes from a single clean input.
- The default opener policy covers `Generic` actions (tag 5), which is how a
  decision names an operation.

Validator fingerprints are unchanged, so no redeployment is required. The Preprod
reference scripts WERE republished on 2026-08-01, so consumers must pick up the new
out-refs from `src/core/deployments/preprod.json`.

### Added

- `deployModuleScripts` (admin): publishes the standalone-module validators
  (`savings`, `escrowV2`, `pool`, `project`, `governanceDispatcher`,
  `governanceVoting`) as reference scripts at the permanent always-fails address,
  with the size ceiling, launch-surface freeze and indexing poll `deployScripts`
  already applied to the six ROSCA refs. Idempotent via `options.existing`, and a
  recorded reference that carries a different hash is republished alongside the old
  one rather than replacing it, so positions bound to the old hash stay spendable.
- `refScripts` (admin): the shared reference-script deploy layer behind both deploy
  functions. `spendableWalletUtxos` filters reference-script UTxOs out of the input
  set a deploy may spend, passed to Lucid as `presetWalletInputs`.
- `EscrowV2ScriptRefs` and `scriptRefs` on every escrow v2 endpoint that witnesses a
  validator (20 endpoints; previously only `allocateToEscrow`, under the name
  `escrowScriptRef`). Session defaults via `configureEscrowV2ReferenceScripts`,
  mirroring the ROSCA convention.
- `getPoolEscrows` (escrow v2 query): lists the live escrows a pool has funded, so a
  fundraiser can offer a list where `allocateToEscrow`'s `existingStateTokenName`
  previously required a token name supplied from memory.
- `GroupFullError` and `InsufficientFundsError`: `joinGroup` now names a full group
  and an unfundable deposit before signing, rather than surfacing them as a validator
  crash and a coin-selection failure.
- `groupTokenSuffix` (optional) on `CancelRecoveryConfig`, to pick which group's
  recovery request is being vetoed when the same fresh account token backs a request
  in more than one. SDK-side selection only: the veto carries no group on-chain.

### Changed

- `verifyProtocolDeployment` asserts the always-fails address for all ten reference
  scripts. The module refs were previously exempt as "deployer-owned by design"; a
  reference at a spendable address is one coin selection away from being destroyed,
  which is how the savings reference was lost on Preprod.
- `ReferenceScriptMismatchError.validator` accepts the module validator names.

### Deprecated

- `AllocateToEscrowConfig.escrowScriptRef`, in favour of `scriptRefs: { escrow }`.
  Still honoured, and it wins when both are supplied.

## [0.5.7-preprod.0] - 2026-07-29

Validator fingerprints are unchanged, so no redeployment is required. This completes
the multi-group treasury resolution started in 0.5.6-preprod.0, which covered only
`exitGroup` and `executeRecovery`.

### Added

- `AmbiguousUtxoError`: raised when a unit resolves to more than one live UTxO.
  Separate from `UtxoNotFoundError` because it is permanent: consumer retry loops
  that poll on a missing UTxO must not retry it.
- `resolveTreasuryUtxoForGroup` and `treasuryGroupRefName` (core utils): resolve a
  member's treasury UTxO by (member token, group) using `utxosAtWithUnit`, rather
  than by unit alone.
- `groupTokenSuffix` (optional) on `ClaimPayoutConfig` and
  `UpdatePayoutCredentialConfig`, to name the group when an account is a live
  member of more than one. Existing single-group callers are unaffected.

### Fixed

- `contribute`, `extendGraceWindow`, `claimPayout` and `updatePayoutCredential`
  resolved the member treasury UTxO by unit alone. A member's treasury token name
  is their account (222) token name, which the validator requires, so one identity
  in two groups has two live UTxOs under one unit and `utxoByUnit` rejects with
  "Unit needs to be an NFT or only held by one address". Every member who joined a
  second group hit this.
- `terminateGroup` and `terminateDefault` scanned the treasury address filtering on
  the member token only, and returned the first match regardless of group. They now
  filter on `group_reference_tokenname`, matching `exitGroup`.
- `approveRecovery` and `cancelRecovery` resolved the RecoveryRequest token by unit,
  which collides when the same fresh account backs a pending request in two groups.
- `resolveUtxoByUnit` discarded the underlying provider reason, so a permanent
  ambiguity surfaced as a transient "not found". The reason and cause are preserved.

### Changed

- `terminateDefault` and `terminateGroup` now report `InvalidDatumError` when the
  member has a treasury UTxO in the named group but it is not in the expected state.
  They previously reported `UtxoNotFoundError`, because a group-blind scan for the
  state simply found nothing.

## [0.5.6-preprod.2] - 2026-07-26

Pre-production release carrying the governance fixes needed by downstream consumers.
Validator fingerprints are unchanged from 0.5.6-preprod.1, so no redeployment is required.

### Added

- `splitEligibility` (governance) — pays supplied tokens into one-name-per-UTxO
  outputs. Required because the on-chain member-id derivation expects the voter
  input to hold exactly one token name under `member_policy`, and ordinary
  change handling merges tokens back together. It must be a separate, earlier
  transaction: the input has to already be clean when register or vote runs.
- `gateWitnessProgram` (governance) — the gate half of a governed action,
  returned as a `TxBuilder => TxBuilder` extension so it can be applied inside
  the governed primitive's own transaction. `authorizeAction` is unchanged and
  still exported.
- `PartyWitness.extend` (savings) — optional hook that lets a caller supply the
  spend which satisfies a script quorum, for script quorums needing a redeemer
  of their own.
- `loadDeployment(network)` and a committed Preprod deployment manifest, so
  consumers read reference-script coordinates from the package instead of
  hardcoding them.

### Fixed

- `registerVoter` and `castVote` now select an eligibility UTxO holding exactly
  one token name under `member_policy`, and fail with an actionable
  `ConfigurationError` when none exists. Previously they picked the first UTxO
  holding the token and the transaction failed on-chain with the opaque
  `Withdraw[0] the validator crashed / exited prematurely`. This is reachable
  in normal use: savings derives a fresh member token name per join, so a
  member of two funds holds two names under one policy.
- `applyQuorumWitness` (savings) no longer silently ignores `extend` when the
  quorum is a key credential — it would have degraded a governed action into a
  plain signature while leaving the decision live at the gate. Supplying both
  `script` and `extend` is now an explicit error.
- The example `state.json` path now resolves from the working directory, so
  running compiled examples and source examples no longer read two different
  files.

### Changed

- The deployment verifier covers all ten module reference scripts (previously
  six), and records an unresolvable reference as an issue rather than passing
  silently. Governance dispatcher and voting hashes are seed-derived, so an
  absent governance seed is reported explicitly.

### Known limitations

- Governance decisions bind to a target fund, not to a specific action. A
  passed `ParamChange` decision can authorise any quorum-gated action on that
  same fund (for example `socialPayout` or `closeFund`). This is the
  documented design position of the semantics-free gate, not a regression —
  but integrators must not treat a decision as action-scoped.

## [0.5.6-preprod.0] - 2026-07-24

Pre-production npm release for the final Preprod acceptance pass. Validator
fingerprints are unchanged from 0.5.5.

### Fixed

- `exitGroup` and `executeRecovery` now resolve treasury states within the
  selected group. Accounts that belong to multiple groups no longer produce an
  ambiguous account-derived treasury token lookup.
- The package export map now exposes the CommonJS files already produced by the
  build for every public entry point.

### Changed

- Prerelease versions publish under their prerelease npm dist-tag (for example,
  `0.5.6-preprod.0` publishes as `preprod`) and cannot replace `latest`.
- Prereleases may publish only from `staging`; stable versions remain restricted
  to `main`.
- Dependency audit runs only after the build, registry, and test gates.
- pnpm 11 install policy lives exclusively in `sdk/pnpm-workspace.yaml`; the
  ignored legacy `package.json#pnpm` field was removed. The standalone examples
  workspace now follows the same rule and has a reproducible prerelease lockfile.
- SDK README examples now match the profile-commitment account API and the
  BUSL-1.1 license.
- CODEOWNERS now names the repository's actual maintainers instead of a
  placeholder account.

## [0.5.5] - 2026-07-17

The final hash-changing release on the ROSCA launch surface before audit wave 1.
The **group and account validators change hash** (fresh protocol deployment
required — see MIGRATION.md); treasury, settings, and escrow are byte-identical
to 0.5.0.

### Added

- **Config-safety envelope, on-chain** — group configs must satisfy
  `recovery_threshold` in `[2, max_members]`, `recovery_timelock` ≥ 1 day, and
  `recommit_window` ≥ 1 day (`min_recovery_threshold` / `min_recovery_timelock`
  / `min_recommit_window` in group.ak). One member can no longer propose and
  execute a recovery alone, every group keeps a real `CancelRecovery` veto
  window, and a re-seal always has a member opt-out window.
- **Pre-join update re-validation** — the shared `is_group_config_valid` runs at
  CreateGroup AND every pre-join UpdateGroup, which also now pins CIP-68
  `version`, a non-empty metadata name, `active_member_count`, and `start_time`.
  A pre-join update can no longer publish a group state creation would reject.
- `computeProfileCommitment(profile, saltHex)` — canonical salted blake2b-256
  profile commitment (`dcu:profile:v1` domain), with frozen test vectors.
- SDK pre-flight validation of the envelope floors in `createGroup`
  (`MIN_RECOVERY_THRESHOLD`, `MIN_RECOVERY_TIMELOCK_MS`, `MIN_RECOMMIT_WINDOW_MS`).

### Changed

- **`AccountDatum` (breaking)** — raw UTF-8 `display_name`/`contact` are
  replaced by one optional `profile_commitment` (length 0 or 32, enforced
  on-chain). No personally identifying information is stored on-chain. Create
  defaults to `""`; `updateAccount` preserves the current value when the field
  is omitted and clears it on explicit `""`.
- `examples/create-group.ts` respects the protocol ceiling (`max_members` 20,
  was 30) and defaults `recovery_threshold` to a majority instead of 1.

### Removed

- `display_name` / `contact` from `AccountDatum`, `createAccount`, and
  `updateAccount` — migration steps in MIGRATION.md.

## [0.5.0] - 2026-07-17

Feature release. All 20 rosca validators and the v1 escrow validator are
byte-identical to 0.4.1 — existing deployments and state.json files continue to
work. The new validators are additive; `validator-registry.json` records every
fingerprint from this release on.

### Added

- **Savings module** (`@tx-meta/dcu-kit/savings`) — ASCA/VSLA savings-and-credit
  engine in one `savings_vault` validator: member shares with member-claimed
  share-out, and share-secured loans (disburse, repay, arrears, write-off). Ten
  endpoints, loan queries, reference-script deploy, and lifecycle examples.
  `experimental` family: emulator-tested, not yet run on a public network.
- **Governance module** (`@tx-meta/dcu-kit/governance`) — propose → vote → decide
  across settings, thin dispatcher, withdraw-zero voting, and gate-seam validators.
  Voter-record nullifier and roster, (policy, name) action binding, validity-interval
  enforcement, charter invariants, and a `GovAction::Generic` arm (opener class 5,
  deny-by-default). Full lifecycle proven on Preprod, including on-chain rejection of
  a double vote and a premature expiry. `experimental` family.
- **Escrow v2** — split beneficiaries with co-beneficiary payouts, project anchor,
  and the pooled commitment vault (create, deposit, exit, allocate, tranche, close)
  as three new validators (`escrow_v2`, `pool_vault`, `project`) beside the untouched
  v1 escrow.
- **Validator registry** — `validator-registry.json` (plus a bundled SDK copy) with
  per-family status, per-validator fingerprints, deployments, and a hash-change
  history; `isDeployAllowed` restricts Mainnet deploys to `launch` families.
  `VERSIONING.md`, `THREAT_MODEL.md`, and `DEPENDENCY_POLICY.md` document the rules.
- **CI and release integrity** — registry drift check, gitleaks secret scanning,
  production dependency audit, Semgrep pilot, and per-project blueprint-drift checks;
  CI is a required status check on `main` and `staging`. The publish workflow re-runs
  the full suite, verifies the tag is an ancestor of `main`, and emits a CycloneDX
  SBOM with npm provenance.

### Changed

- Governance `finalizeProposal` / `executeDecision` / `expireProposal` align clamped
  `validFrom` bounds up to whole slots, so boundary-adjacent transactions build
  correctly on live networks.
- `governance-mint-tokens` mints member and target tokens into separate outputs, as
  voter registration expects single-token-name eligibility inputs.

### Fixed

- Escrow final `Release` returns the funder's min-ADA buffer instead of stranding it
  with the beneficiary.
- Escrow seed selection skips reference-script UTxOs.
- Pool allocation computes the anchor's sorted reference-input index, fixing
  allocation against pools with reference scripts present.

## [0.4.1] - 2026-07-05

Patch release on the v0.4.0 deployment. No validator hash changes; deployments and
state.json files from v0.4.0 continue to work.

### Added

- `examples/create-multisig.ts`: builds a native M-of-N multisig over the example
  wallets' payment keys and records it in state.json.
- `examples/multisig-admin.ts`: shared helper that detects script-held admin custody,
  attaches the `AdminAuthConfig` witness, and co-signs with raw payment keys.
- Script-held admin support across the admin-op examples: update-group, delete-group,
  start-group, extend-grace-window, terminate-default, terminate-group, and
  begin-recommit co-sign with `SIGNER_WALLETS`; assign-admin supplies the recorded
  script as the destination spendability proof.
- create-group env overrides for the grace period, recommit window, and recovery
  timelock.

### Changed

- Eight endpoints run real UPLC on the emulator: extendGraceWindow, terminateGroup,
  proposeRecovery, approveRecovery, cancelRecovery, executeRecovery, contribute, and
  claimPayout. Only distributePayout keeps `localUPLCEval: false` (the scale benchmark
  reads its unevaluated transaction).
- Examples README documents the live six-script Preprod deployment and the multisig
  admin flow.

### Fixed

- `cancelRecovery` / `executeRecovery` include the settings reference input required by
  the treasury dispatcher; without it neither endpoint could run on a live network.
- `proposeRecovery` pays each approver's account UTxO back to its owner instead of
  leaking the membership token into the proposer's change.
- Example wiring found during the live sweep: escrow-abort and propose-recovery co-sign
  with raw payment keys, cancel-recovery passes the full script-ref set, contribute
  passes scriptRefs, missing inspect-state script entry, examples effect pin aligned
  with the SDK's ^3.21.4.

## [0.4.0] - 2026-07-04

### Coop-SDK — Treasury split (deploy unblock, R4)

**Immutable-contract change → new treasury hashes.** The 25,262-byte treasury validator
exceeded the ~16,128-byte deployable-reference-script ceiling and could never go on-chain
as compiled. It is now a thin dispatcher plus four withdraw-zero family stake validators,
partitioned by redeemer family:

| Validator                                                               | Hash                | Size     |
| ----------------------------------------------------------------------- | ------------------- | -------- |
| treasury dispatcher                                                     | `9c54823e010820a8…` | 2,592 B  |
| treasury_rounds (distribute)                                            | `f7a2262bcdf6240a…` | 5,771 B  |
| treasury_lifecycle (join/exit/contribute/payout/grace/claims/terminate) | `b4090fbde4f5c070…` | 11,200 B |
| treasury_recovery (propose/approve/cancel/execute)                      | `f16fc034e7c2c730…` | 7,310 B  |
| treasury_reserve (create/top-up/cover/refund/close)                     | `2dff16b23a98aa2b…` | 7,267 B  |

Group `32da6e88…`, account `d80e2e5a…`, settings `07a7cd9d…`, and escrow `3f04186f…` are
byte-unchanged. `TreasuryDatum` is unchanged — no indexer datum migration.

#### Added

- Four treasury family stake validators; every treasury operation now carries one 0-ADA
  reward withdrawal from its family, whose action redeemer holds the tx indices plus
  `covered_inputs` — the list of treasury spend positions the action authorizes (the pin
  rule). The dispatcher requires every spent treasury UTxO to be covered.
- `ProtocolSettings` gains four appended `ScriptHash` fields:
  `treasury_rounds_stake` / `treasury_lifecycle_stake` / `treasury_recovery_stake` /
  `treasury_reserve_stake`.
- SDK: `attachFamilyWithdrawal` / `familyRewardAddress` (`core/familyWithdraw`),
  `registerTreasuryStake` (registers the four family stake credentials; idempotent),
  `ScriptRefs` extended to all six protocol scripts, `MAX_REF_SCRIPT_BYTES` deploy guard,
  `MAX_TX_BYTES` submit guard in `signAndSubmit`, and a blueprint-wide script-size test.

#### Changed

- **`TreasuryRedeemer` ABI break**: every variant is now field-less except
  `DistributeRound { withdrawal_index }` — constructor order unchanged. All indices moved
  to the family action redeemers.
- One family action per family per tx: the family validator is located by withdrawal
  purpose, so a tx may carry at most one withdrawal per family credential (composite
  operations combine different families, e.g. join = lifecycle + reserve).
- `deployScripts` deploys six reference scripts (one tx each) and then registers the four
  stake credentials. Deposits: **~233 ADA** min-ADA locked permanently at the alwaysFails
  address (scales with script size), plus 4 × 2 ADA stake deposits (reclaimable).
- Reference scripts are required on live networks for every treasury endpoint;
  `attachFamilyWithdrawal` rejects a missing family ref outside the emulator.

#### Deployed

- **Preprod (2026-07-04)**: settings policy `f90df179…`, six reference scripts, four stake
  registrations. Full live lifecycle validated — create / join ×3 / distribute
  (8,022 B, 49% of budget) / terminate ×3 / delete — all under the tx-size limit.

### Coop-SDK Phase 6 — Mutual reserve (Cluster C)

**Immutable-contract change → new hashes** (group `32da6e88…`, treasury `d829dda8…`; account and
settings unchanged). Not deployed — supersedes the Phase-5 bundle in the open hash window.

#### Added

- **Mutual reserve** — one `ReserveState` UTxO per group under the treasury validator, created
  one-shot in the `createGroup` tx and identified by a permanent reserve token
  (`"RSVE" + group suffix`, treasury policy). The on-chain welfare fund: configurable
  `reserve_join_levy` (once per join) and `reserve_round_levy` (per member per round) accrue
  into it; both default 0 (off) and freeze once a member joins.
- **Objective default cover (the stand-in).** `terminateDefault` now routes the defaulter's
  forfeited balance INTO the reserve and adds their remaining rounds this lap to
  `standin_rounds`; while positive, each distribute round draws `min(fee, pot)` into the
  payout so later borrowers still receive full pots. The counter decrements even on a dry
  draw, and `beginRecommit`'s clean gate additionally requires `standin_rounds == 0`.
- **Wind-down refunds.** Once deactivated, each `exitGroup` may take
  `floor(balance / pre-exit member_count)` from the reserve (`claimReserveShare`, default on);
  `deleteGroup` closes the reserve (token burn, residue to change).
- New endpoint `topUpReserve` (permissionless, increase-only donations) and query
  `getReserveState` (`balance`, `standinRounds`, `joinLevy`, `roundLevy`);
  `reserveTokenName` helper. New `dcu/reserve.ak` on-chain module.
- `scriptRefs` support added to `createGroup`, `deleteGroup`, `terminateGroup`,
  `updatePayoutCredential`, and `extendGraceWindow` — create/delete now run both minting
  policies and no longer fit inline together.

#### Changed

- **`TerminateDefault` forfeit destination**: reserve, not admin (the admin keeps only the
  defaulter's min-ADA lovelace). `GroupDatum` gains `reserve_join_levy`/`reserve_round_levy`
  (appended); `TreasuryDatum` gains the `ReserveState` variant (appended);
  `TreasuryRedeemer` gains `CreateReserve`/`ReserveTopUp`/`ReserveCover`/`ReserveRefund`/
  `ReserveClose` (appended); `BeginRecommit` gains `reserve_ref_input_index` (appended).
  Indexer notes in [`MIGRATION.md`](./MIGRATION.md).
- Scale probe re-measured with the reserve leg: N=20 worst case 10.54M mem (75% of budget) —
  `max_group_members = 20` stands.

#### Security

- Review gate (MLabs checklist, full pass): one CONFIRMED major fixed — the reserve is
  restricted to an enterprise address at creation, closing a creator staking-reward skim on
  the communal pot. Cover/refund legs are pinned to shapes only a genuine
  terminate/wind-down-exit can produce.

### Coop-SDK Phase 5 — Recommit / cycle reset (Cluster B)

**Immutable-contract change → new hashes** (group `0fb5601d…`, treasury `1a132ad6…`; account and
settings unchanged). Not deployed — supersedes the Phase-2 bundle in the open hash window.

#### Added

- **Recommit window** (`beginRecommit` + extended `startGroup`): at a completed lap OR a
  provable vacant-slot halt (every remaining member clean), the admin opens an opt-out reset
  window — distribution pauses, joining re-opens, every exit is free for at least
  `recommit_window` (new group field, default 3 days). `startGroup` re-seals with fresh
  first-come-first-served slots and a new rotation era. The vacant-slot halt finally has a
  release valve; wind-down becomes the fallback.
- `GroupDatum` gains `member_slots` (authoritative slot map, parallel to the registry),
  `era_start_round`, and `recommit_window`.

#### Changed

- **Slot ownership moved to the group datum.** `assigned_slot` is removed from
  `TreasuryState`/`DefaultState`; the distribute borrower is resolved from the group registry
  by token name. All rotation math (slot, round time gate, exit maturity, ICS lap boundary) is
  era-relative; `round_number` stays monotonic across resets.
- Joining now enters in lockstep (`rounds_paid = last_distributed_round + 1`), which also
  admits members during a recommit window.
- `RecoverMember`/`executeRecovery` swap the registry entry in place, preserving the member's
  rotation turn.

#### Fixed

- **Pre-start slot collision**: join → join → exit → join used to hand the new member a
  colliding slot and leave slot 0 permanently vacant, bricking the group at round 0. Slots are
  now assigned at seal time, making the scenario structurally impossible.
- ICS transitions after a re-seal fire at the correct era-relative rounds.

### Coop-SDK Phase 4 — milestone escrow (`@tx-meta/dcu-kit/escrow`)

A new standalone product in the cooperative-finance family. Own Aiken project and blueprint
(escrow validator `3f04186f…`) — DCU protocol hashes are untouched.

#### Added

- **Escrow validator family** (`onchain/escrow/`): funder locks ADA or a native token; a configurable
  verifier releases sequential milestone tranches to the beneficiary's pinned full address; the
  funder reclaims the remainder strictly after expiry; funder + beneficiary co-sign aborts. One
  one-shot state token per escrow; one escrow input per tx (double-satisfaction excluded);
  creation must prove it happened before expiry and covers the milestone total; at most 100
  milestones (release cost measured linear: 1.04M mem at 50 tranches, 7.4% of budget).
- **`credential_authorized` primitive** — VK ⇒ signature, script ⇒ spent input at the script's
  payment credential: funder/verifier/beneficiary can each be a wallet key or any multisig with
  no adapter code.
- **SDK module** `@tx-meta/dcu-kit/escrow`: `createEscrow` (returns the escrow's permanent
  `stateTokenName`), `releaseMilestone`, `reclaimEscrow`, `abortEscrow`, `getEscrowState`;
  `verifierWitness`/`funderWitness` implement the dust-UTxO pattern for script parties.
- Docs: “Escrow: Milestone Payments” page — the four target configurations (bank→developer,
  chama land purchase, supplier prepayment, startup funding round), retention-as-last-milestone,
  and the dust-UTxO pattern.
- Tests: 471 Aiken checks (pass/fail suites, fuzzers, boundary properties, ex-units probe) and
  7 emulator lifecycle round-trips (create → releases → burn, reclaim, co-signed abort, 2-of-3
  multisig verifier).

### Coop-SDK Phase 1–2 — modular multisig, credential fee routing, recovery quorum hardening

**Immutable-contract change → new hashes** (group `269dde42…`, treasury `87782df0…`; account and
settings unchanged). Not yet deployed — Preprod redeploy + external audit remain the gates.

#### Added

- **Standalone multisig module** — `@tx-meta/dcu-kit/multisig` subpath export (`buildMultisig`,
  `AdminAuthConfig`, `payAdminReturn`, `applyAdminWitness`); `@tx-meta/dcu-kit/core` also exported.
  Existing import paths keep working.
- **Joining fees can route to a multisig.** `creator_payment_credential` is now a `Credential`
  (`{ VerificationKey: [pkh] }` or `{ Script: [hash] }`); the on-chain fee check matches the
  credential, whichever kind it is. `createGroup` verifies a `Script` creator credential is
  spendable (`creatorScript` proof) and rejects protocol script hashes.
- **`assignAdmin` destination guard** — transferring the admin token to a script address now
  requires `destinationScript` proving the address is spendable (`force: true` to override).
- Docs: “Rotation, Exits & Halts” page — vacant-slot semantics and the wind-down procedure.

#### Changed

- **ExecuteRecovery quorum hardened**: approvals are re-checked against the current registry
  (exited vouchers no longer count) and the threshold is clamped to
  `max(1, min(recovery_threshold, member_count − 1))` — a group that shrank below its configured
  threshold keeps a reachable quorum instead of permanently losing recovery.
- **Continuation outputs preserve the spent input's full address** in every SDK-built
  transaction (stake credential included), matching the on-chain full-address pins.
- Quorum helpers moved to `dcu/quorum` on-chain (generic M-of-N token-holder signature
  primitives; behavior unchanged).

### Cluster A — flexible admin authority + lost-member recovery

**Immutable-contract change → new hashes** (group `ade13889…`, treasury `a5e00e3b…`; account unchanged).
Not yet deployed — Preprod redeploy + external audit remain the gates.

#### Added

- **Multisig admin (SDK-only, no validator change).** `buildMultisig(signers, M)` builds a native
  `atLeast M of N` script; `assignAdmin(groupTokenSuffix, destinationAddress)` moves the group admin (222)
  token to it (or to a VK delegate). All 6 admin ops (`startGroup`, `updateGroup`, `deleteGroup`,
  `extendGraceWindow`, `terminateDefault`, `terminateGroup`) accept an optional `adminScript` to spend a
  script-held admin token. The single-VK admin path is unchanged.
- **Lost-member recovery** — a member who loses their account token recovers via member quorum:
  `proposeRecovery` → `approveRecovery` (async, to threshold) → wait out the timelock → `executeRecovery`
  rotates the member's identity to a new account token; `cancelRecovery` is the veto. Two new group datum
  fields (`recovery_threshold`, `recovery_timelock`); a `RecoveryRequest` treasury datum variant; four
  treasury redeemers + a group `RecoverMember` redeemer (all appended — Constr indices stable).

#### Changed

- **Reference scripts are now required** for `joinGroup`/`startGroup`/`contribute` and all recovery
  operations — the recovery logic grew the treasury validator past the 26000-byte inline tx-size limit.
  Deploy with `deployScripts` and pass `scriptRefs`. (`scriptRefs` added to `startGroup` + `contribute`.)
- **Treasury continuation outputs now pin the full address** (stake credential included), closing a latent
  staking-reward skim on permissionless distribute (AIK-4).

## [0.3.0] - 2026-06-15

Continuous round model — the ROSCA now cycles indefinitely with one cheap distribute per
round and no per-cycle maintenance transaction. **Immutable-contract redesign → new hashes
→ Preprod redeploy + external audit required before mainnet.**

### Changed

- **Breaking:** rounds are now a single monotonic counter (`round_number`); a cycle is the
  counter crossing a multiple of `num_rounds`. Group lifetime is indefinite until terminated.
- **Breaking:** `GroupDatum` gains `active_member_count` — the cached count of contributing
  members. `DistributeRound` reads it in O(1) for the pro-rata pot, replacing the O(N²)
  `count_active_members` fold (distribute is now **O(N)**).
- **Breaking:** exit free/penalty boundary is re-anchored to `rounds_paid % num_rounds == 0`
  (a completed cycle), replacing the wall-clock maturity computation.

### Added

- `Recover` redeemer — `contribute`-based recovery of a `DefaultState` member re-admits them
  to the active set (`active_member_count + 1`).

### Removed

- **Breaking:** `NextCycle` — the per-cycle batch reset (redeemer, withdraw handler, endpoint,
  and the `count_active_members` fold) is deleted; continuous rounds make it unnecessary.

### Security

- **Breaking (hash):** treasury `38b14e40 → 2023c689`, group `54d48e2f → 3ddc716a`
  (account/settings/`always_fails` unchanged). C4 anti-skim preserved via
  `length(treasury_input_indices) == active_member_count` + per-input group link.
  **`deploy-scripts` required.** Self-review (`cardano-aiken-review`): no critical/major.

## [0.2.7] - 2026-06-15

Post-audit hardening, scale work, and licensing. Builds on 0.2.6; no settings/deploy-flow
change, but the treasury validator hash shifts (see Security) so **`deploy-scripts` is
required** before use.

### Added

- `getGroupMetadata(source)` / `getGroupName(source)` — decode a group's CIP-68 metadata
  to a plain `Record<string, string>` (or read `metadata["name"]`) without hand-rolling
  the `fromText`/`toText` plumbing. Accept both `GroupCip68Datum` and `GroupCip68Parts`.
- `getGroupHistory` hardening — request timeout, retry with backoff, bounded concurrency,
  and `tx_index` ordering for deterministic lifecycle reconstruction.
- `deploy-scripts` now registers the treasury stake credential (required for the
  withdraw-zero round handlers to validate on-chain).

### Changed

- **Breaking:** `createAccount` / `createGroup` resolve to `{ tx, accountTokenSuffix }` /
  `{ tx, groupTokenSuffix }` instead of a bare `TxSignBuilder`, surfacing the permanent
  CIP-68 token suffix so consumers stop re-deriving it from output 0.
  See [MIGRATION.md](./MIGRATION.md#026--027).
- Package renamed to `@tx-meta/dcu-kit` (was `@dcu/dcu-sdk`).
- `UpdateGroup` freeze is now an explicit allowlist of mutable fields (defence-in-depth);
  blueprint recompiled to match.

### Security

- treasury `DistributeRound` now conserves the treasury UTxO's lovelace for native-token
  groups, closing a permissionless ADA-reserve skim.
- Withdraw-zero round handlers + an on-chain `max_members` cap (20) bound per-tx CPU at
  scale. AIK-4 (treasury stake credential) and AIK-1/2 (distribute scale) documented as
  known-latent.
- **Breaking (hash):** all four validators recompiled this release —
  treasury `982d5c8d → 38b14e40`, group `24f046d5 → 54d48e2f`,
  account `e32328b8 → d80e2e5a`, settings `0dd2c77a → 07a7cd9d`
  (`always_fails` unchanged). **`initialize-settings` + `deploy-scripts` required.**

### Licensing

- Toolkit licensed under BUSL-1.1 (converts to Apache-2.0); added `SECURITY.md`
  vulnerability-reporting policy.

## [0.2.6]

Audit-hardened ROSCA release — closes the security review's mainnet gate. Re-validated
end-to-end on Preprod (Aiken 181/0, SDK 36/36). Full notes:
[`RELEASE_NOTES_v0.2.6.md`](./RELEASE_NOTES_v0.2.6.md).

### Changed

- **Breaking:** SDK is settings-bound — group/treasury endpoints are built per deployment
  with `createDcuSdk(settingsPolicy)` instead of static imports (P5 trusted binding).
- **Breaking:** new deploy flow `initialize-settings → deploy-scripts`.
- **Breaking (hash):** treasury recompiled `d1bf38fb → 982d5c8d`; group/account policy IDs
  shift (now settings-parameterized). Redeploy required.

### Removed

- **Breaking:** `DeferRound` — replaced by Pull mode + `claimPayout`.

### Added

- Pull-mode payouts + `claimPayout` (lost-wallet-safe withdrawal via `claimable_balance`).
- Native-token contribution groups (all three fees).
- Defaulter lifecycle: `DefaultState` recovery via `contribute` (B1) and admin
  `terminateDefault` after grace (B2).
- Min-ADA reserve (B3); optional on-chain group description in CIP-68 metadata.

### Security

- C1–C3 settings-NFT trusted group↔treasury binding; C4 pro-rata complete-member-set
  distribute; M1 configurable `collateral_rounds`; M2 NextCycle re-funding guard.

## [0.2.5]

### Changed

- **Breaking:** group reference datum wrapped in `GroupCip68Datum`
  (`{ metadata, version, extra }`) — decode via `parseGroupCip68Datum`, read `.groupDatum`.
- **Breaking:** `AccountDatum` `email_hash`/`phone_hash` → `display_name`/`contact`, now
  raw UTF-8 (not sha256); `sha256` dependency dropped.
- **Breaking:** `GroupDatum` `num_intervals` → `num_rounds`,
  `admin_payment_credential` → `creator_payment_credential`.
- **Breaking:** `TreasuryDatum` `InsufficientCollateralState` → `DefaultState`, with a
  `Contribute` recovery path and new `assigned_slot` / `member_payment_credential` fields.
- **Breaking:** `createGroup` requires `groupName` (populates `metadata["name"]`).
- **Breaking (hash):** all three protocol validators recompiled. Redeploy required.

See [MIGRATION.md](./MIGRATION.md#024--025) for before/after snippets.

## [0.2.4]

- Baseline for the migration notes above.

[Unreleased]: https://github.com/tx-meta/dcu-kit/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/tx-meta/dcu-kit/compare/v0.2.7...v0.3.0
[0.2.7]: https://github.com/tx-meta/dcu-kit/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/tx-meta/dcu-kit/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/tx-meta/dcu-kit/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/tx-meta/dcu-kit/releases/tag/v0.2.4
