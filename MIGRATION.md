# Migration Guide

Breaking-change migration notes for `@tx-meta/dcu-kit`, newest first. Each section
lists what changed, why, and the before/after edit. Because the DCU validators are
unparameterized-per-version, **any release that changes a validator hash requires a
fresh `deploy-scripts` run** — stale reference scripts make txs fail on-chain with
cryptic script errors. Validator hashes for each release are tabled at the bottom.

---

## `0.5.0` → `0.5.5` (P1 launch-surface last call)

The group and account validators change hash; treasury, settings, and escrow are
byte-identical. Because the protocol settings UTxO pins the group/account policy
IDs immutably, this is a **fresh protocol deployment** (new settings NFT + new
reference scripts via `deploy-scripts`), not a script swap. Nothing is deployed on
Mainnet; existing Preprod instances keep working through the OLD deployment and
the SDK version that created them — no state migrates.

### `AccountDatum` ABI break (wire format)

`display_name` / `contact` (raw UTF-8, PII on-chain) are REPLACED by a single
`profile_commitment: ByteArray` — either `""` (no profile, the default) or a
32-byte salted blake2b-256 commitment computed off-chain via
`computeProfileCommitment(profile, saltHex)`. The caller keeps the profile and
salt; the chain stores no identity data. Accounts created under 0.5.x or earlier
are not decodable by this SDK version — close them with the OLD SDK version, or
leave them on the old deployment.

```ts
// before
createAccount(lucid, { selected_out_ref, display_name: "@alice", contact: "a@b" });
// after — private by default…
createAccount(lucid, { selected_out_ref });
// …or with a commitment (store profile + salt off-chain)
createAccount(lucid, {
  selected_out_ref,
  profileCommitment: computeProfileCommitment('{"name":"@alice"}', salt),
});
```

`updateAccount`: `profileCommitment` omitted = preserve the current on-chain
value; explicit `""` = clear it.

### Group config-safety envelope (create + pre-join update)

`createGroup` datums must now satisfy: `recovery_threshold` in `[2, max_members]`
(so `max_members >= 2`), `recovery_timelock >= 86_400_000` ms (1 day), and
`recommit_window >= 86_400_000` ms (1 day). The same envelope is re-validated by
every pre-join `UpdateGroup`. Group configs created with `recovery_threshold: 1`
or shorter windows are rejected on-chain and by the SDK's pre-flight check.

### Kyama / indexer note

Credential-based indexing is unaffected. Display names must come from the
product-layer store — they no longer exist on-chain anywhere.

---

## Unreleased (Coop-SDK — Treasury split)

The treasury validator is now a dispatcher (`9c54823e…`) plus four withdraw-zero family
stake validators: rounds `f7a2262b…` / lifecycle `b4090fbd…` / recovery `f16fc034…` /
reserve `2dff16b2…`. Group / account / settings / escrow hashes and `TreasuryDatum` are
unchanged. Re-run `deploy-scripts`: it deploys **six** reference scripts and registers the
four family stake credentials (all four registrations are required before any treasury
endpoint works — the ledger rejects withdrawals from unregistered credentials).

### `TreasuryRedeemer` ABI break (wire format)

Every variant is field-less except `DistributeRound { withdrawal_index }`. Constructor
order is unchanged. Anything decoding treasury redeemers (indexers, explorers) must drop
the old field layouts; the operation's indices now live on the family action redeemer of
the tx's 0-ADA family withdrawal.

```ts
// before
Data.to({ ExitGroup: { member_input_index: 0n, ... } }, TreasuryRedeemer)
// after — spend redeemer is a bare literal…
Data.to("ExitGroup", TreasuryRedeemer)
// …and the indices ride on the family withdrawal (built by attachFamilyWithdrawal)
```

### `ProtocolSettings` gains four appended fields

`treasury_rounds_stake`, `treasury_lifecycle_stake`, `treasury_recovery_stake`,
`treasury_reserve_stake` (28-byte script hashes). Existing field order unchanged.
`initializeSettings` writes them; `verifySettings` checks them.

### One family action per family per tx

The dispatcher finds the family withdrawal by purpose (stake credential), so a tx carries
at most one action per family. Composite operations pair different families (join =
lifecycle + reserve levy; terminate-default = lifecycle + reserve cover; wind-down exit =
lifecycle + reserve refund).

### Deploy deposits

Six reference scripts lock **~233 ADA** min-ADA permanently at the alwaysFails address
(the old two-script deploy locked ~56 ADA). The 4 × 2 ADA stake-key deposits are
reclaimable. Budget this per deployment: any future hash change means a fresh ~233 ADA.

## Unreleased (Coop-SDK Phase 6 — Mutual reserve, Cluster C)

New validator hashes (group `32da6e88…`, treasury `d829dda8…`) superseding the Phase-5
bundle — re-run `deploy-scripts` when this releases. Indexer-impacting changes:

### `GroupDatum` gains two fields (appended — existing field order unchanged)

```ts
groupDatum: {
  ...params,
  reserve_join_levy: 0n,   // one-time reserve levy per join, contribution asset
  reserve_round_levy: 0n,  // per-member per-round reserve levy, contribution asset
}
```

### `TreasuryDatum` gains a fifth variant: `ReserveState` (Constr index 4)

```ts
ReserveState: {
  group_reference_tokenname: string; // the bound group's (100) ref token name
  standin_rounds: bigint;            // fee-units owed to future rounds' pots
}
```

Exactly one exists per group, created in the `createGroup` tx and identified by a
reserve token under the **treasury** policy: `"52535645" ("RSVE") + group suffix`
(`reserveTokenName(groupRefName)` in the SDK). Indexers watching the treasury address
must expect this non-member UTxO.

### `TerminateDefault` forfeit destination changed

The defaulter's forfeited contributable balance now flows INTO the reserve (with a
`standin_rounds` increment), not to the admin. The admin keeps only the defaulter's
min-ADA lovelace as change. Anything reconciling terminate transactions must follow
the new value flow.

### `TreasuryRedeemer` gains five variants (appended)

`CreateReserve`, `ReserveTopUp`, `ReserveCover`, `ReserveRefund`, `ReserveClose` —
existing constructor indices unchanged.

### `BeginRecommit` redeemer gains a field (appended)

`reserve_ref_input_index` — the reserve rides recommit txs as a reference input; the
clean gate additionally requires `standin_rounds == 0`.

### `createGroup` / `deleteGroup` now run BOTH minting policies

Creating a group also mints the reserve token (treasury `CreateReserve`); deletion
burns it (`ReserveClose`). The two validators no longer fit inline together — these
endpoints (plus `terminateGroup`, `updatePayoutCredential`, `extendGraceWindow`,
`claimPayout` in size-tight paths) now accept `scriptRefs` and should be given the
deployed reference scripts. `createGroup` also requires the settings UTxO on-chain.

---

## Unreleased (Coop-SDK Phase 5 — Recommit)

New validator hashes (group `0fb5601d…`, treasury `1a132ad6…`) superseding the Phase-2
bundle — re-run `deploy-scripts` when this releases. Two breaking datum changes
(indexers and anything parsing raw datums must update):

### `GroupDatum` gains three fields (appended — existing field order unchanged)

```ts
groupDatum: {
  ...params,
  member_slots: [],            // authoritative slot map; [] until startGroup seals
  era_start_round: 0n,         // rotation era base; managed by startGroup
  recommit_window: 259_200_000n, // opt-out window length (3 days); yours to configure
}
```

### `assigned_slot` removed from `TreasuryState` and `DefaultState`

The rotation slot lives in the group datum's `member_slots` (parallel to
`member_token_names`). Constructor field positions after the removed slot SHIFT —
re-derive any hand-decoded treasury datums. A member's slot is now read as:

```ts
const ix = groupDatum.member_token_names.indexOf(memberRefTokenName);
const slot = ix >= 0 ? groupDatum.member_slots[ix] : undefined; // undefined pre-seal
```

`joinGroup` no longer computes a slot; fresh members enter with
`rounds_paid = last_distributed_round + 1` (0 on a fresh group).

---

## `0.3.0` → Unreleased (Coop-SDK Phase 2)

New validator hashes (group `269dde42…`, treasury `87782df0…`) — re-run `deploy-scripts`
when this releases. One breaking SDK type change:

### `creator_payment_credential` is now a `Credential`

The field was a bare 28-byte PKH string; it is now a tagged credential so joining fees
can route to a multisig or contract.

```ts
// Before
groupDatum: { ...params, creator_payment_credential: creatorPkh }

// After — wallet key (the common case)
groupDatum: {
  ...params,
  creator_payment_credential: { VerificationKey: [creatorPkh] },
}

// After — multisig fee destination (pass the script as proof)
const multisig = await buildMultisig(lucid, { signers, required }).unsafeRun();
createGroup(lucid, {
  ...config,
  groupDatum: {
    ...params,
    creator_payment_credential: { Script: [multisig.policyHash] },
  },
  creatorScript: multisig.script,
});
```

`createGroup` rejects a `Script` credential without a matching `creatorScript` (or
`force: true`), and always rejects protocol script hashes as fee destinations.

---

## `0.2.7` → `0.3.0`  ⭐ current release

The **continuous round model**. The group cycles indefinitely; there is no per-cycle
`NextCycle` transaction. Most integrators need three changes.

### 1. `NextCycle` is gone

Delete any `nextCycle` call and its scheduling. Distribute simply keeps running — a new
cycle begins automatically when `round_number` crosses a multiple of `num_rounds`.

```ts
// Before — reset the group each cycle
await sdk.nextCycle(lucid, config).unsafeRun();

// After — nothing. Keep calling distribute each round; cycles roll over on their own.
await sdk.distributePayout(lucid, config).unsafeRun();
```

### 2. `GroupDatum` gains `active_member_count`

A new `Int` field caching the number of contributing members. It is `0` at creation, set to
`member_count` by `startGroup`, and maintained by the protocol (+1 join/recover,
−1 exit/terminate/ICS). Any code that constructs a `GroupDatum` must add the field; any code
that reads the datum by position must account for it.

### 3. Exit boundary is round-based, not time-based

Free vs penalty exit now keys off whether the member has completed a whole cycle
(`rounds_paid % num_rounds == 0`) instead of a wall-clock maturity time. No SDK call changes;
the on-chain decision is just more robust across unlimited cycles.

### 4. Validator hash change → redeploy

| Validator | v0.2.7 | v0.3.0 |
|---|---|---|
| treasury | `38b14e406a21f44e` | `2023c6894336a168` |
| group | `54d48e2f3b03eb98` | `3ddc716a5a1d7994` |

account, settings, and `always_fails` are unchanged, so the settings policy ID is stable —
**re-run `deploy-scripts`** (no need to re-`initialize-settings`) and refresh stored
reference-script outRefs. This is an immutable-contract redesign: Preprod redeploy + full
e2e + external audit gate mainnet.

---

## `0.2.6` → `0.2.7`

### `createAccount` / `createGroup` now resolve to an object

Both endpoints previously resolved to a bare `TxSignBuilder`. They now resolve to
`{ tx, …Suffix }`, surfacing the permanent CIP-68 token suffix the SDK already derives
internally — so consumers stop re-fetching output 0 and string-slicing the asset key.

```ts
// Before
const tx = await createAccount(lucid, config).unsafeRun();
const signed = await tx.sign.withWallet().complete();

// After
const { tx, accountTokenSuffix } = await createAccount(lucid, config).unsafeRun();
const signed = await tx.sign.withWallet().complete();
// accountTokenSuffix is the 28-byte (56 hex char) account identity — feed it
// straight into updateAccount / joinGroup instead of re-deriving it.
```

`createGroup` mirrors this, resolving to `{ tx, groupTokenSuffix }`.

### New metadata helpers (additive, non-breaking)

`getGroupMetadata(source)` decodes a group's CIP-68 metadata to a plain
`Record<string, string>`; `getGroupName(source)` returns `metadata["name"]` or
`undefined`. Both accept anything with a `metadata` field (the typed `GroupCip68Datum`
or the `GroupCip68Parts` from `parseGroupCip68Datum`), so you no longer hand-roll the
`fromText("name")` / `toText()` plumbing.

### Validator hash change → redeploy

**All four validators recompiled this release** (ADA-reserve conservation, withdraw-zero
round handlers, `UpdateGroup` freeze allowlist, and an Aiken toolchain bump together shift
every hash):

| Validator | v0.2.6 | v0.2.7 |
|---|---|---|
| treasury | `982d5c8dc0872f93` | `38b14e406a21f44e` |
| group | `24f046d5b86ff58b` | `54d48e2f3b03eb98` |
| account | `e32328b8dd296c53` | `d80e2e5a82cb60b3` |
| settings | `0dd2c77a083ca729` | `07a7cd9d64681a33` |

The settings policy ID changes, so **re-run `initialize-settings`** (it produces the new
`createDcuSdk(settingsPolicy)` argument) **then `deploy-scripts`**, and refresh any stored
reference-script outRefs.

---

## `0.2.5` → `0.2.6`

The audit-hardened ROSCA release. This is the migration most integrators need: it makes
the SDK **settings-bound**, recompiles the treasury validator, and retires `DeferRound`.
Full notes in [`RELEASE_NOTES_v0.2.6.md`](./RELEASE_NOTES_v0.2.6.md).

### 1. Endpoints are settings-bound — derive them per deployment

Group/treasury endpoints are no longer static module imports. The treasury validator is
now parameterized by the deployment's settings NFT (P5 trusted binding), so you build the
endpoint set once per deployment with `createDcuSdk(settingsPolicy)`.

```ts
// Before — static imports
import { joinGroup } from "@tx-meta/dcu-kit";
await joinGroup(lucid, config).unsafeRun();

// After — bind to the deployment's settings policy
import { createDcuSdk } from "@tx-meta/dcu-kit";
const sdk = createDcuSdk(settingsPolicy); // settingsPolicy from initialize-settings
await sdk.joinGroup(lucid, config).unsafeRun();
```

`createAccount` / `updateAccount` stay static (the account validator is a root and is not
settings-parameterized).

### 2. New deploy flow: `initialize-settings` → `deploy-scripts`

Mint the singleton settings NFT first, then deploy reference scripts. The settings policy
ID it produces is the argument to `createDcuSdk`.

### 3. `DeferRound` removed

The deferral redeemer/endpoint is gone. A member who would have deferred their turn now
uses **Pull mode** — the pot earmarks into their own treasury via `claimable_balance`, and
they withdraw it with `claimPayout` whenever they like.

```ts
// Before
await deferRound(lucid, config).unsafeRun();

// After — create the group with payout_mode: "Pull", then later:
await sdk.claimPayout(lucid, { groupTokenSuffix, /* … */ }).unsafeRun();
```

### 4. Validator hash change → redeploy

Treasury recompiled (`d1bf38fb → 982d5c8d`); group/account blueprint logic is unchanged
but their **policy IDs shift** because they are now settings-parameterized. Re-run
`deploy-scripts` and refresh any stored reference-script outRefs.

---

## `0.2.4` → `0.2.5`

This release renamed identity fields, wrapped the group datum in a CIP-68 envelope, and
recompiled three of four validators. All four changes are silent at the type level (code
compiles but produces wrong on-chain data or throws at runtime), so review each.

### 1. `GroupDatum` is now wrapped in `GroupCip68Datum`

The group reference-token datum is a 3-field CIP-68 wrapper
`{ metadata, version, extra: GroupDatum }`. Decoding the UTxO datum directly as
`GroupDatum` throws `"Fields do not match"` at runtime.

```ts
// Before
const group = Data.from(utxo.datum!, GroupDatum);

// After — decode the wrapper, then read .extra
import { parseGroupCip68Datum } from "@tx-meta/dcu-kit";
const parts = await parseGroupCip68Datum(utxo.datum).pipe(/* run */);
const group = parts.groupDatum; // the GroupDatum
// Display name lives in the wrapper's metadata:
const name = getGroupName(parts); // "Savings Club" | undefined
```

`createGroup` correspondingly requires a `groupName` (populates `metadata["name"]`).

### 2. `AccountDatum` field rename (and semantic change)

| v0.2.4 | v0.2.5 | Notes |
|---|---|---|
| `email_hash: ByteArray` | `display_name: ByteArray` | now **raw UTF-8**, not a sha256 hash |
| `phone_hash: ByteArray` | `contact: ByteArray` | now **raw UTF-8**, not a sha256 hash |

The validator's identity check changed from `length == 32` (a hash) to `length > 0`
(any non-empty UTF-8). Both fields default to the wallet address when omitted, and the
`sha256` dependency was dropped from `createAccount` / `updateAccount`. Code that
constructs or reads `AccountDatum` compiles unchanged but writes the wrong on-chain data.

```ts
// Before
const datum = { email_hash: sha256(email), phone_hash: sha256(phone) };

// After
const datum = { display_name: fromText("@alice"), contact: fromText("alice@dcu.io") };
```

### 3. `GroupDatum` field renames

| v0.2.4 | v0.2.5 | Notes |
|---|---|---|
| `num_intervals` | `num_rounds` | counts rounds, not time; set to `member_count` by `startGroup`, `0` at creation |
| `admin_payment_credential` | `creator_payment_credential` | joining fees route here |

### 4. `TreasuryDatum` variant rename + recovery semantics

`InsufficientCollateralState` → `DefaultState`. This is **not just a rename**: a
defaulting member can now top up and recover to `TreasuryState` via `Contribute` during
the grace window. `DefaultState` also gained two fields required for that path —
`assigned_slot` and `member_payment_credential`. Any consumer constructing or matching
on this variant must add both.

### 5. Validator hashes changed → redeploy

All three protocol validators recompiled (`always_fails` unchanged). Re-run
`deploy-scripts` and refresh any stored reference-script outRefs.

---

## Validator hashes by release

Blueprint hashes (first 16 bytes). A change in any row means that release requires a
redeploy of that validator's reference script.

| Validator | v0.2.5 | v0.2.6 | v0.2.7 | v0.3.0 |
|---|---|---|---|---|
| treasury | `d1bf38fb921ec64c` | `982d5c8dc0872f93` | `38b14e406a21f44e` | `2023c6894336a168` |
| group | `d19e192b1d005dd8` | `24f046d5b86ff58b` | `54d48e2f3b03eb98` | `3ddc716a5a1d7994` |
| account | `394027d4084e26f5` | `e32328b8dd296c53` | `d80e2e5a82cb60b3` | `d80e2e5a82cb60b3` |
| settings | — | `0dd2c77a083ca729` | `07a7cd9d64681a33` | `07a7cd9d64681a33` |
| always_fails | `22c9a103ed3f2fa9` | `22c9a103ed3f2fa9` | `22c9a103ed3f2fa9` | `22c9a103ed3f2fa9` |

Unreleased (treasury split): treasury becomes `9c54823e010820a8` (dispatcher) plus
`f7a2262bcdf6240a` (rounds), `b4090fbde4f5c070` (lifecycle), `f16fc034e7c2c730`
(recovery), `2dff16b23a98aa2b` (reserve); group `32da6e881778a415`, account, settings,
and escrow `3f04186f…` unchanged from the Phase-6 row.

From v0.2.6 the group/treasury policy IDs are additionally parameterized by the
deployment's settings NFT (`createDcuSdk(settingsPolicy)`); see the v0.2.6 notes below.

For the full v0.2.6 release notes (Pull mode, settings-bound SDK, audit fixes) see
[`RELEASE_NOTES_v0.2.6.md`](./RELEASE_NOTES_v0.2.6.md).
