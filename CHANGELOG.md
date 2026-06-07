# Changelog

All notable changes to `@tx-meta/dcu-sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to semantic
versioning. Migration steps for every breaking change live in [`MIGRATION.md`](./MIGRATION.md).

## [Unreleased]

### Added
- `getGroupMetadata(source)` / `getGroupName(source)` — decode a group's CIP-68 metadata
  to a plain `Record<string, string>` (or read `metadata["name"]`) without hand-rolling
  the `fromText`/`toText` plumbing. Accept both `GroupCip68Datum` and `GroupCip68Parts`.

### Changed
- **Breaking:** `createAccount` / `createGroup` resolve to `{ tx, accountTokenSuffix }` /
  `{ tx, groupTokenSuffix }` instead of a bare `TxSignBuilder`, surfacing the permanent
  CIP-68 token suffix so consumers stop re-deriving it from output 0.
  See [MIGRATION.md](./MIGRATION.md#unreleased--next-027).

### Security
- **Breaking (hash):** treasury `DistributeRound` now conserves the treasury UTxO's
  lovelace for native-token groups, closing a permissionless ADA-reserve skim. Treasury
  hash `982d5c8d → 0c7d8087` — **`deploy-scripts` required**.

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

[Unreleased]: https://github.com/tx-meta/dcu-kit/compare/v0.2.6...HEAD
[0.2.6]: https://github.com/tx-meta/dcu-kit/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/tx-meta/dcu-kit/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/tx-meta/dcu-kit/releases/tag/v0.2.4
