# DCU Toolkit Examples

Standalone scripts for manually testing every SDK endpoint on Cardano Preprod.
Each script compiles with `tsup` and runs via `pnpm run <script-name>`.

## Prerequisites

### 1. Environment file

The examples directory reads its config from a `.env` file. The simplest setup is a symlink to the SDK's `.env`:

```bash
cd sdk/examples
ln -s ../.env .env
```

Or copy `sdk/.env` and edit it directly. Required variables for live-network testing:

```ini
NETWORK=Preprod
PROVIDER=Blockfrost
BLOCKFROST_KEY=preprodXXXXXXXXXXXXXXXXXXXXXX

ADMIN_SEED="word word word ..."
USER1_SEED="word word word ..."
USER2_SEED="word word word ..."
```

Supported wallet names: `ADMIN`, `USER1`, `USER2`. Set `ACTIVE_WALLET=<name>` as a prefix to select which wallet a script uses.

### 2. Fund wallets

Print all three wallet addresses and fund them at the Preprod faucet:

```bash
pnpm run show-wallets
# → prints ADMIN, USER1, USER2 addresses

# Fund each at: https://docs.cardano.org/cardano-testnets/tools/faucet
```

All three wallets need ADA. Rule of thumb:
- **ADMIN**: 100 ADA (covers group creation bond, deploy-scripts, joining fee)
- **USER1 / USER2**: 50 ADA each (covers contribution amount × max_members + tx fees)

### 3. Install dependencies

```bash
pnpm install
```

### 4. (Recommended) Deploy reference scripts

Reference scripts reduce transaction size from ~16 KB to ~4.5 KB. Without them some transactions may exceed the Cardano size limit.

```bash
ACTIVE_WALLET=ADMIN pnpm run deploy-scripts
```

This deploys two UTxOs holding the compiled validators to the admin address (~30 ADA locked total). Their `txHash + outputIndex` are saved to `state.json` and used automatically by all subsequent scripts.

---

## Running any script

```bash
pnpm run <script-name>
```

Every invocation runs `pnpm run build` first (tsup compiles all `*.ts` files to `dist/`).

To target a non-default wallet, prefix with `ACTIVE_WALLET`:

```bash
ACTIVE_WALLET=USER2 pnpm run create-account
ACTIVE_WALLET=USER2 pnpm run join-group
```

---

## State

Token suffixes and group timing are persisted in `state.json` between runs. Each script reads from and writes to this file automatically. The file tracks:

| Key | Written by | Used by |
|-----|-----------|---------|
| `groupTokenSuffix` | `create-group` | All treasury scripts |
| `groupPolicyId` | `create-group` | Staleness check |
| `groupIntervalLength` | `create-group` | Slot schedule display |
| `groupStartTime` | `start-group` | Slot schedule display |
| `groupNumIntervals` | `start-group` | Slot schedule display |
| `accountTokenSuffix` | `create-account` (USER1) | `join-group`, `exit-group` |
| `adminAccountTokenSuffix` | `create-account` (ADMIN) | `join-group` |
| `user2AccountTokenSuffix` | `create-account` (USER2) | `join-group` |
| `scriptRefTreasury` | `deploy-scripts` | `join-group` (inline fallback otherwise) |
| `scriptRefGroup` | `deploy-scripts` | `join-group` (inline fallback otherwise) |

**Never commit `state.json`** — it contains live on-chain identifiers.

To start fresh:

```bash
pnpm run reset-state
```

### Validator staleness check

Every live-network script compares the current SDK's policy IDs against those stored in `state.json`. If they differ (meaning the on-chain contracts were upgraded), the script exits with a clear error:

```
ERROR: Validator hashes have changed since state.json was last written.
Run 'pnpm run reset-state' to clear stale state, then recreate the group.
```

---

## Helper scripts

| Script | Purpose |
|--------|---------|
| `show-wallets` | Print ADMIN/USER1/USER2 addresses, balances, and UTxOs |
| `send-ada` | Send ADA between wallets. Env: `FROM_WALLET=ADMIN TO_WALLET=USER1 AMOUNT=5000000` |
| `deploy-scripts` | Deploy treasury + group reference scripts (~30 ADA total). Run once as ADMIN. |
| `reset-state` | Wipe `state.json` to start a fresh test session |
| `purge-nfts` | Burn all account/group NFTs held by a wallet (emergency cleanup) |

---

## Endpoints

### Account

| Script | Default wallet | What it does |
|--------|---------------|-------------|
| `create-account` | USER1 | Mints an Account NFT. Saves the token suffix to `state.json`. |
| `update-account` | USER1 | Updates email/phone hash metadata on the account UTxO. |
| `delete-account` | USER1 | Burns the account NFT and reclaims the locked ADA. |

### Group

| Script | Default wallet | What it does |
|--------|---------------|-------------|
| `create-group` | ADMIN | Creates a group UTxO with the configured fee parameters. Saves `groupTokenSuffix` and `groupIntervalLength`. |
| `update-group` | ADMIN | Updates editable group parameters (fees, max_members). Locked once any member has joined. |
| `delete-group` | ADMIN | Burns group tokens and reclaims ADA. Requires `member_count == 0` and `is_active == false`. |

### Treasury

| Script | Default wallet | What it does |
|--------|---------------|-------------|
| `join-group` | USER1 | Joins the active group. Locks `max_members × contribution_fee` into the treasury. Assigns the next available slot. |
| `start-group` | ADMIN | Seals membership, sets `num_intervals = member_count`, anchors `start_time`. Saves timing to `state.json`. **Required before distribute-payout.** |
| `distribute-payout` | ADMIN | Collects all treasury contributions for the current round and pays the borrower. Permissionless — any wallet can submit. |
| `exit-group` | USER1 | Exits the group. Returns all remaining ADA (mature exit) or creates a PenaltyState UTxO (early exit). |
| `terminate-group` | ADMIN | Releases the PenaltyState UTxO. Only needed after an early exit creates one. |

---

## Fee structure

Every group has three fee amounts, each with an independent asset:

**`contribution_fee`** — the amount each member locks into the treasury upfront for **all** future rounds (`max_members × contribution_fee` paid at join time). This is the core savings pot that rotates through the group.

**`joining_fee`** — a one-time fee paid when joining. Routes to `admin_payment_credential` and is not returned on exit.

**`creator_bond`** — ADA locked in the group UTxO at creation. Returned to the admin on `delete-group` once all members have exited. Deters spam groups.

**`penalty_fee`** — the amount forfeited if a member exits before the group matures. Set higher to discourage early exit:

| Setting | Value | Effect |
|---------|-------|--------|
| No penalty | `0n` | Free exit, weak deterrent |
| Moderate (40%) | `2_000_000n` on a 5 ADA fee | Some deterrent, low friction |
| Full (100%) | Equal to `contribution_fee` | Full contribution forfeited, strong deterrent |

### Stablecoin configuration

To use a native asset or stablecoin instead of ADA, set the `_policyid` and `_assetname` fields in `create-group.ts`. Amounts are in the token's smallest unit.

```ts
// USDM on Mainnet (6 decimal places, so 5_000_000 = 5 USDM)
contribution_fee_policyid:  "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc535",
contribution_fee_assetname: "41474958",
contribution_fee:           5_000_000n,
```

For ADA, leave both `_policyid` and `_assetname` as `""` (empty bytes). Never use `"00"` — that looks up a non-existent 1-byte token and returns 0.

---

## How slots work

The DCU Toolkit implements a **round-based rotation**. Each member is assigned a slot index when they join (first joiner = slot 0, second = slot 1, etc.).

After `start-group` is called:
- `start_time` is anchored to the transaction's validity window lower bound
- `num_intervals` is fixed to `member_count`
- Rounds are numbered sequentially starting from 0

**Round eligibility:**
- `round_number = last_distributed_round + 1`
- `current_slot = round_number % num_intervals`
- A round can be distributed when: `current_time >= start_time + round_number × interval_length`
- The borrower is the member with `assigned_slot == current_slot`

**Deferred payout:** If the scheduled borrower has `is_deferred = true`, the payout routes to `(current_slot + 1) % num_intervals` instead. The flag is always reset to `false` after a distribute.

**Maturity:** The group matures when all `num_intervals` rounds have been distributed (`last_distributed_round == num_intervals - 1`). After maturity, exits are free (no penalty).

`distribute-payout` prints the current slot and time until the next window on every run, so you can check at any time without spending gas.

---

## Group lifecycle

### Full ROSCA cycle (3 members, 5-minute intervals)

```
Create group (ADMIN)          → group UTxO on-chain, is_started=false
  Create accounts (×3)        → account UTxOs for ADMIN, USER1, USER2
  Join group × 3              → ADMIN=slot0, USER1=slot1, USER2=slot2
  Start group (ADMIN)         → is_started=true, num_intervals=3, start_time=now
  Wait 5 minutes              →
  Distribute round 0          → ADMIN (slot 0) receives pot (15 ADA)
  Wait 5 minutes              →
  Distribute round 1          → USER1 (slot 1) receives pot
  Wait 5 minutes              →
  Distribute round 2          → USER2 (slot 2) receives pot
  Exit group × 3              → all mature exits (no penalty), treasury UTxOs burned
  Delete group (ADMIN)        → group UTxO burned, creator_bond returned
```

### Early exit path

If a member exits during an active rotation (before maturity):

```
Exit group (USER1)            → PenaltyState UTxO created (penalty_fee locked)
Terminate group (ADMIN)       → PenaltyState burned, penalty_fee goes to admin
```

### Deactivate + delete flow

The group can be deactivated at any time (even with members):

```
update-group (is_active=false) → flags group as inactive
delete-group                   → burns tokens, returns ADA (requires member_count=0)
```

---

## Step-by-step manual test

This is the recommended sequence for a complete test on Preprod with three wallets.

### Step 0: Check wallets and fund

```bash
pnpm run show-wallets
# → prints ADMIN, USER1, USER2 addresses
```

Fund all three at https://docs.cardano.org/cardano-testnets/tools/faucet.
Wait for funding transactions to confirm (~1 minute on Preprod).

### Step 1: Deploy reference scripts (once per SDK version)

```bash
ACTIVE_WALLET=ADMIN pnpm run deploy-scripts
```

Locks ~30 ADA to the admin address as reference scripts. Saves `scriptRefTreasury` and `scriptRefGroup` to `state.json`. Re-run only if the SDK is upgraded.

### Step 2: Create accounts

Each participant needs an account NFT before they can join a group. Create one per wallet:

```bash
ACTIVE_WALLET=ADMIN pnpm run create-account
# → mints Account NFT, saves adminAccountTokenSuffix to state.json

ACTIVE_WALLET=USER1 pnpm run create-account
# → mints Account NFT, saves accountTokenSuffix to state.json

ACTIVE_WALLET=USER2 pnpm run create-account
# → mints Account NFT, saves user2AccountTokenSuffix to state.json
```

### Step 3: Create the group

```bash
ACTIVE_WALLET=ADMIN pnpm run create-group
# → creates group UTxO, saves groupTokenSuffix + groupIntervalLength to state.json
```

The group is created with `is_started=false` and `num_intervals=0`. Members join next; `start-group` fixes these values once all members are in.

Open `create-group.ts` to review the parameters before running:
- `TEST_MODE = true` → 5-minute intervals, 5-member cap
- `CONTRIBUTION_FEE = 5_000_000n` → 5 ADA per slot
- `JOINING_FEE = 2_000_000n` → 2 ADA one-time

### Step 4: Join the group

Each wallet joins in turn. **Join order determines slot assignment** — first joiner = slot 0, second = slot 1, third = slot 2.

```bash
ACTIVE_WALLET=ADMIN pnpm run join-group
# → ADMIN joins as slot 0, treasury UTxO created with assigned_slot=0

ACTIVE_WALLET=USER1 pnpm run join-group
# → USER1 joins as slot 1, treasury UTxO created with assigned_slot=1

ACTIVE_WALLET=USER2 pnpm run join-group
# → USER2 joins as slot 2, treasury UTxO created with assigned_slot=2
```

Each join locks `max_members × contribution_fee` (default: 5 × 5 ADA = 25 ADA) into a treasury UTxO.

### Step 5: Start the group

Once all members have joined, the admin seals membership and starts the clock:

```bash
pnpm run start-group
# → sets is_started=true, num_intervals=3, start_time=<now>
# → saves groupStartTime + groupNumIntervals to state.json
# → prints the full slot schedule
```

After this, no new members can join. The validator will reject any further `join-group` calls.

### Step 6: Distribute payouts

Wait for the first interval to elapse (5 minutes in `TEST_MODE`), then distribute:

```bash
pnpm run distribute-payout
# → round 0: ADMIN (slot 0) receives 3 × 5 ADA = 15 ADA
# → rounds_paid incremented to 1 in all treasury UTxOs
```

Repeat after each interval:

```bash
# After another 5 minutes:
pnpm run distribute-payout
# → round 1: USER1 (slot 1) receives 15 ADA

# After another 5 minutes:
pnpm run distribute-payout
# → round 2: USER2 (slot 2) receives 15 ADA
```

`distribute-payout` is **permissionless** — any wallet can call it. The payout always goes to the borrower's stored `member_payment_credential`, not the caller.

If called too early (before `start_time + round × interval_length`), the transaction fails with a clear validator error.

### Step 7: Exit the group

After all rounds are distributed, every exit is a **mature exit** (full refund, no penalty):

```bash
ACTIVE_WALLET=USER2 pnpm run exit-group
# → USER2 treasury UTxO burned, remaining ADA returned

ACTIVE_WALLET=USER1 pnpm run exit-group
# → USER1 treasury UTxO burned, remaining ADA returned

ACTIVE_WALLET=ADMIN pnpm run exit-group
# → ADMIN treasury UTxO burned, remaining ADA returned
```

### Step 8: Delete the group

Once `member_count == 0`, the admin can remove the group:

```bash
ACTIVE_WALLET=ADMIN pnpm run update-group   # set is_active=false first
ACTIVE_WALLET=ADMIN pnpm run delete-group   # burns group tokens, returns creator_bond
```

---

## Testing early exit + terminate

To test the penalty path, exit a member **before** all rounds are distributed:

```bash
# After start-group but before the group matures:
ACTIVE_WALLET=USER1 pnpm run exit-group
# → PenaltyState UTxO created (penalty_fee locked in it)

# Admin claims the penalty:
ACTIVE_WALLET=ADMIN pnpm run terminate-group
# → PenaltyState burned, penalty_fee sent to admin
```

`terminate-group` reads `MEMBER_WALLET` from the environment to resolve which member's penalty to claim:

```bash
MEMBER_WALLET=USER1 ACTIVE_WALLET=ADMIN pnpm run terminate-group
```

---

## Negative tests (expected failures)

These confirm that the on-chain validators enforce protocol rules:

```bash
# Join a group that has already been started → validator rejects it
pnpm run start-group   # first, seal the group
ACTIVE_WALLET=USER2 pnpm run join-group   # should fail: is_started=true

# Distribute payout before the group is started → validator rejects it
# (Create group + join members, but skip start-group)
pnpm run distribute-payout   # should fail: "not been started"

# Distribute payout before the interval has elapsed → validator rejects it
pnpm run distribute-payout   # immediately after start-group, before 5 minutes
# → fails: time gate not satisfied

# Update contribution_fee after members have joined → validator rejects it
ACTIVE_WALLET=ADMIN pnpm run update-group   # edit contribution_fee in update-group.ts first
# → fails: critical field is frozen

# Delete an active group (is_active=true) → validator rejects it
ACTIVE_WALLET=ADMIN pnpm run delete-group
# → fails: must deactivate first
```

---

## Emulator mode

Set `NETWORK=Emulator` (or `NETWORK=Custom`) in `.env`. Treasury scripts (`join-group`, `start-group`, `distribute-payout`, `exit-group`, `terminate-group`) exit early in emulator mode because they depend on prior on-chain state persisted across processes.

Use `rosca-lifecycle.ts` for a self-contained emulator walkthrough of the full ROSCA cycle:

```bash
NETWORK=Custom pnpm run rosca-lifecycle
```
