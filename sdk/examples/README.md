# DCU Toolkit Examples

Standalone scripts for manually testing every SDK endpoint on Cardano Preprod.
Each script compiles with `tsup` and runs via `pnpm run <script-name>`.

## Prerequisites

### 1. Environment file

The examples directory needs its own `.env`. The simplest setup is a symlink to the SDK's `.env`:

```bash
cd sdk/examples
ln -s ../.env .env
```

Or copy `sdk/.env` and edit it directly. The required variables:

```ini
NETWORK=Preprod
PROVIDER=Blockfrost
BLOCKFROST_KEY=preprodXXXXXXXXXXXXXXXXXXXXXX

ADMIN_SEED="word word word ..."
USER1_SEED="word word word ..."
WALLET3_SEED="word word word ..."
```

### 2. Fund wallets

Print all three wallet addresses:

```bash
pnpm run generate-wallets
```

Fund each address at the [Preprod faucet](https://docs.cardano.org/cardano-testnets/tools/faucet). All three wallets need ADA before testing treasury endpoints.

### 3. Install dependencies

```bash
pnpm install
```

## Running any script

```bash
pnpm run <script-name>
```

Every invocation runs `pnpm run build` first (tsup compiles all `*.ts` files to `dist/`). To target a non-default wallet, prefix with `ACTIVE_WALLET`:

```bash
ACTIVE_WALLET=WALLET3 pnpm run create-account
ACTIVE_WALLET=WALLET3 pnpm run join-group
```

Supported values: `USER1` (default), `ADMIN`, `WALLET3`.

## State

Token suffixes and group timing are persisted in `state.json` between runs. Each script reads from and writes to this file automatically. Never commit `state.json` as it contains live on-chain identifiers.

To reset and start fresh:

```bash
echo "{}" > state.json
```

## Endpoints

### Account

| Script | Wallet | What it does |
|---|---|---|
| `create-account` | USER1 or WALLET3 | Mints an Account NFT. Saves `accountTokenSuffix` (USER1) or `wallet3AccountTokenSuffix` (WALLET3) to state. Skips if the suffix is already saved. |
| `update-account` | USER1 | Updates metadata fields on the account UTxO. |
| `delete-account` | USER1 | Burns the account NFT and reclaims ADA. |

### Group

| Script | Wallet | What it does |
|---|---|---|
| `create-group` | ADMIN | Creates a group UTxO with the configured parameters, then immediately joins as slot 0 (if `JOIN_IMMEDIATELY = true`). Saves `groupTokenSuffix`, `groupStartTime`, `groupIntervalLength`, and `groupNumIntervals` to state. |
| `update-group` | ADMIN | Updates editable group parameters. |
| `delete-group` | ADMIN | Removes the group UTxO and reclaims ADA. |

### Treasury

Treasury scripts require an active group and at least one joined member. They are time-sensitive: each member can only receive a payout during their assigned slot window.

| Script | Wallet | What it does |
|---|---|---|
| `join-group` | USER1 or WALLET3 | Joins the active group. Prints the assigned slot and current slot schedule. |
| `distribute-payout` | Any | Collects all claimable contributions and pays the current slot's borrower. Prints the slot schedule before attempting the transaction. |
| `member-withdraw` | USER1 | Withdraws the member's own contribution early. |
| `exit-group` | USER1 | Exits the group and burns the treasury membership NFT. |
| `terminate-group` | ADMIN | Terminates the group. |

## Fee structure

Every group has three fee amounts, each with its own asset (`_policyid` + `_assetname`):

**`contribution_fee`** — the amount each member locks into the treasury per interval, paid upfront for all intervals at join time. This is the core savings amount that circulates through the group.

**`joining_fee`** — a one-time fee paid by the member when joining. Goes to the protocol (admin) and is not returned on exit.

**`penalty_fee`** — the amount forfeited if a member exits before the group matures. Set higher to discourage early exit. Recommended range:

| Setting | Value | Effect |
|---------|-------|--------|
| No penalty | `0n` | Free exit, weak deterrent |
| Moderate (e.g. 40%) | `2_000_000n` on a 5 ADA fee | Some deterrent, low friction |
| Full (100%) | `CONTRIBUTION_FEE` | Full contribution forfeited, strong deterrent |

All three fees can be set independently. The asset for each fee is configured separately, so you can mix ADA joining fees with stablecoin contributions.

### Stablecoin configuration

To use a native asset or stablecoin instead of ADA, set the `_policyid` and `_assetname` fields. Amounts are in the token's smallest unit.

```ts
// USDM on Mainnet (6 decimal places, so 5_000_000 = 5 USDM)
contribution_fee_policyid:  "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc535",
contribution_fee_assetname: "41474958",
contribution_fee:           5_000_000n,
```

For ADA, leave both `_policyid` and `_assetname` as `""` (empty bytes). The SDK uses `quantity_of(value, "", "")` which resolves to lovelace. Do not use `"00"` — that would look up a non-existent 1-byte token and return 0.

---

## Group lifecycle

The full ROSCA cycle runs from `start_time` through `start_time + num_intervals * interval_length`. After that point all slots have passed and the group has matured.

### End-of-cycle flow

Once all intervals have elapsed, members exit cleanly — no penalty is applied because the group has matured:

```
is_early_exit = is_active && now < (start_time + num_intervals * interval_length)
```

When `now >= maturity_time`, `is_early_exit` is false, so any exit burns the treasury NFT and returns the remaining ADA to the member.

```bash
# After maturity: exit in any order — no penalty for any member
pnpm run exit-group
ACTIVE_WALLET=WALLET3 pnpm run exit-group

# Once member_count reaches 0, the admin can remove the group
pnpm run delete-group
```

`delete-group` (RemoveGroup redeemer) enforces `member_count == 0`. The admin reclaims the group UTxO's ADA and the protocol tokens are burned.

The lifecycle is enforced entirely on-chain. No coordinator or off-chain daemon is required — any wallet with the right tokens can call the next step at any time.

---

## Treasury testing: step-by-step

### Step 1: Create accounts

```bash
# Create accounts for all participants first
ACTIVE_WALLET=ADMIN pnpm run create-account
pnpm run create-account
ACTIVE_WALLET=WALLET3 pnpm run create-account
```

### Step 2: Create a group

```bash
pnpm run create-group
```

With `JOIN_IMMEDIATELY = true` (the default), the admin joins immediately after creation as slot 0. The output confirms both transactions:

```
Group created successfully!
Joining as slot 0 (contribution: 15 ADA)...
Admin joined as slot 0. Race condition window closed.
distribute-payout ready: 07:54:50 AM
```

### Step 3: Join with remaining wallets

```bash
pnpm run join-group                        # USER1 -> slot 1
ACTIVE_WALLET=WALLET3 pnpm run join-group  # WALLET3 -> slot 2
```

### Step 4: Wait for the slot 0 window

`distribute-payout` prints the current slot and how long until the next window on every run, so you can check at any time:

```bash
pnpm run distribute-payout
# Current slot: 0  (next slot in 47s)
```

### Step 5: Test remaining endpoints

```bash
pnpm run distribute-payout   # pays USER1 (slot 0 borrower) from both members' contributions
pnpm run member-withdraw     # USER1 withdraws their contribution early
pnpm run exit-group          # USER1 exits the group
pnpm run terminate-group     # ADMIN terminates the group
```

## Understanding slots

The group cycles through slot indices `0` to `num_intervals - 1`, then repeats. Members are assigned a slot in join order: the first to join gets slot 0, the second gets slot 1, and so on.

`distribute-payout` only succeeds when `currentSlot` matches an existing member's `assigned_slot`.

**If called outside the window:** contributions stay in the treasury and accumulate. The borrower receives all accumulated intervals in one payout the next time their slot window opens. Nothing is lost.

**If `currentSlot` falls on an empty slot** (no member joined for that number): the script fails with `No member found for current slot X`. Wait for the next non-empty slot window.

The cycle length is `num_intervals * interval_length`. With the default test config (4 slots, 5-minute intervals), the full cycle is 20 minutes.

## TEST_MODE

`create-group.ts` has a `TEST_MODE` flag near the top:

```ts
const TEST_MODE = true;
```

| Mode | Interval | Slots | Start time |
|---|---|---|---|
| `true` | 5 minutes | 4 | 2 minutes from now |
| `false` | 1 hour | 12 | Now |

The 2-minute delay in test mode gives join transactions time to confirm on-chain before slot 0 begins. Flip to `false` for a realistic production configuration.

## Emulator mode

Set `NETWORK=Emulator` (or omit `NETWORK`) in `.env`. Treasury scripts exit early in emulator mode because they depend on prior on-chain state. Use `rosca-lifecycle.ts` for a self-contained emulator walkthrough of the full ROSCA cycle.
