# Changelog

All notable changes to `@tx-meta/dcu-kit` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to semantic
versioning. Migration steps for every breaking change live in [`MIGRATION.md`](./MIGRATION.md).

## [Unreleased]

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
