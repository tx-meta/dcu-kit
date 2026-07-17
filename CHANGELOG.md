# Changelog

All notable changes to `@tx-meta/dcu-kit` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to semantic
versioning. Migration steps for every breaking change live in [`MIGRATION.md`](./MIGRATION.md).

## [Unreleased]

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
