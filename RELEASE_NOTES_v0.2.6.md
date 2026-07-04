# DCU Toolkit SDK v0.2.6

Audit-hardened ROSCA release: closes the security review's mainnet gate, adds Pull-mode payouts and the full defaulter lifecycle, and fixes the ADA final-round min-UTxO edge. Re-validated end-to-end on Preprod (Aiken 181/0, SDK 36/36).

## ⚠️ Breaking changes
- **Settings-bound SDK (P5).** Endpoints are no longer static — derive them per deployment:
  ```ts
  const sdk = createDcuSdk(settingsPolicy);   // from initialize-settings
  await sdk.joinGroup(lucid, config).unsafeRun();
  ```
  New deploy flow: **`initialize-settings` → `deploy-scripts`**.
- **Validator hashes changed → redeploy required.** Treasury `bf90e909 → 982d5c8d`; group/account blueprints unchanged but their policy IDs shift (now settings-parameterized).
- **`DeferRound` removed** — use Pull mode + `ClaimPayout` instead.
- SDK `0.2.5 → 0.2.6`.

## 🔒 Security (mainnet gate)
- **C1–C3** — settings NFT roots a trusted group↔treasury binding (closes group-forge / ClaimPenalty-forge theft).
- **C4** — pro-rata distribute enforces the complete member set.
- **M1** — configurable `collateral_rounds`. **M2** — NextCycle re-funding guard. **M3** — DeferRound retired.

## ✨ Features
- **Pull mode + `ClaimPayout`** — pot earmarks into the borrower's own treasury for lost-wallet-safe withdrawal.
- **Native-token contribution groups.**
- **Defaulter lifecycle** — DefaultState recovery via `contribute` (B1) and admin `terminateDefault` after grace (B2).
- **Min-ADA reserve (B3)** — ADA groups drain to 0 *contributable* while a 2 ADA reserve carries the token.
- **On-chain group description** — optional CIP-68 `metadata["description"]`, frozen once a member joins.

## 🐛 Fixes
- Compute `group_ref_input_index` (was hardcoded `0`); slot-align distribute `validFrom`; explicit account-token return on `exitGroup`; route `update/delete-account` by `ACTIVE_WALLET`.

## 📦 Validator hashes
| Validator | Blueprint hash | |
|---|---|---|
| treasury | `982d5c8dc0872f938480d6c467aaec11946fecfed2701d891a1c8f21` | changed |
| group | `24f046d5b86ff58b0e317661144240aedb87858ae111577a336c1a18` | unchanged |
| account | `e32328b8dd296c533acbe8d0ef3f9975513aa350d8c37d44217a5c60` | unchanged |

## Migration
1. `pnpm add @tx-meta/dcu-sdk@0.2.6`
2. Run `initialize-settings` then `deploy-scripts`.
3. Swap static imports for `createDcuSdk(settingsPolicy)`.
4. Replace `deferRound` with Pull mode + `claimPayout`.

**Full changelog:** https://github.com/tx-meta/dcu-kit/compare/v0.2.5...v0.2.6
