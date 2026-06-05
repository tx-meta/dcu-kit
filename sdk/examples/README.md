# DCU Toolkit Examples

Standalone scripts for manually testing every SDK endpoint on Cardano Preprod.
Each script compiles with `tsup` and runs via `pnpm run <script-name>`.

---

## Prerequisites

### 1. Environment file

```bash
cd sdk/examples
ln -s ../.env .env
```

Required variables in `.env`:

```ini
NETWORK=Preprod
BLOCKFROST_KEY=preprodXXXXXXXXXXXXXXXXXXXXXX

ADMIN_SEED="word word word ..."
USER1_SEED="word word word ..."
USER2_SEED="word word word ..."
```

`ACTIVE_WALLET=<name>` selects which wallet a script uses (default shown in each script's header).

### 2. Fund wallets

```bash
pnpm run show-wallets
# → prints ADMIN, USER1, USER2 addresses and current ADA balances
```

Fund at: https://docs.cardano.org/cardano-testnets/tools/faucet

Rule of thumb:

- **ADMIN**: 150 ADA (group bond + deploy-scripts + joining fee + collateral)
- **USER1 / USER2**: 50 ADA each (contribution_fee × collateral_rounds + tx fees)

---

## Current validator hashes (Preprod)

| Validator   | Policy ID / Hash                                           |
| ----------- | ---------------------------------------------------------- |
| Account     | `f0d4bf83e11fced2287b706b1efb32764689a8d7912b81a79a8a16cd` |
| Treasury    | `19e8d64beb1cc1143e01bf8f1c1b4a5ed0c208f997f60227f2628625` |
| Group       | `8a29191f7bc9e6a8c244213571bc6d203bf24fd3a24b76effd6af8bc` |
| AlwaysFails | `22c9a103ed3f2fa97c982d76d6e2af50c5d54ac306983b196c8fcdab` |

Reference scripts permanently locked at:
`addr_test1wq3vnggra5ljl2tunqkhd4hz4agvt422cvrfswcedj8um2cwsu3l3`

> **Stale state?** If `state.json` has a different `accountPolicyId` or `groupPolicyId`, the
> validators changed since your last session. Run `pnpm run reset-state` before starting.

---

## Full command sequence (3-wallet ROSCA on Preprod)

Copy-paste in order. Each command waits for on-chain confirmation before returning.

```bash
# ── 0. Reset stale state and check wallets ────────────────────────────────────
pnpm run reset-state
pnpm run show-wallets
# Fund ADMIN ~150 ADA, USER1 ~50 ADA, USER2 ~50 ADA at the Preprod faucet.
# Wait ~1 minute for funding txs to confirm, then continue.

# ── 1. Deploy reference scripts (once per SDK version, ~56 ADA, permanent) ────
pnpm run deploy-scripts
# → tx 1/2: deploys treasury validator (~30 ADA), waits for confirmation (~1 min)
# → tx 2/2: deploys group validator   (~26 ADA), saves both outRefs to state.json
# → both sent to alwaysFails address — permanently locked, never spendable
# → re-running is safe: verifyDeployment detects existing valid UTxOs and exits early

# ── 2. Create an account NFT for each participant ─────────────────────────────
ACTIVE_WALLET=ADMIN pnpm run create-account
# → mints Account NFT for ADMIN, saves adminAccountTokenSuffix to state.json

ACTIVE_WALLET=USER1 pnpm run create-account
# → mints Account NFT for USER1, saves accountTokenSuffix to state.json

ACTIVE_WALLET=USER2 pnpm run create-account
# → mints Account NFT for USER2, saves user2AccountTokenSuffix to state.json

# ── 3. Create the group ───────────────────────────────────────────────────────
pnpm run create-group
# → ADMIN creates group UTxO (is_started=false, num_intervals=0)
# → saves groupTokenSuffix + groupIntervalLength to state.json
# → default config: TEST_MODE (5-min intervals, 5 ADA/slot, 2 ADA joining fee)

# ── 4. Join the group (order = slot assignment) ───────────────────────────────
ACTIVE_WALLET=ADMIN pnpm run join-group
# → ADMIN joins as slot 0, locks 5 × 5 ADA = 25 ADA into treasury UTxO

ACTIVE_WALLET=USER1 pnpm run join-group
# → USER1 joins as slot 1, locks 25 ADA into treasury UTxO

ACTIVE_WALLET=USER2 pnpm run join-group
# → USER2 joins as slot 2, locks 25 ADA into treasury UTxO
# Uses scriptRefTreasury + scriptRefGroup from state.json (tx ~4.5 KB, well under 16 KB limit)

# ── 5. Start the group (seal membership + anchor the clock) ──────────────────
pnpm run start-group
# → is_started=true, num_intervals=3, start_time=<tx lower bound>
# → saves groupStartTime + groupNumIntervals to state.json
# → prints slot schedule: when each round opens
# → validator now rejects any further join-group calls

# ── 6. Distribute payouts (permissionless — any wallet can submit) ────────────
# Wait 5 minutes after start-group, then:
pnpm run distribute-payout
# → round 0: ADMIN (slot 0) receives 3 × 5 ADA = 15 ADA
#    all treasury UTxOs: rounds_paid 0 → 1

# Wait another 5 minutes:
pnpm run distribute-payout
# → round 1: USER1 (slot 1) receives 15 ADA
#    all treasury UTxOs: rounds_paid 1 → 2

# Wait another 5 minutes:
pnpm run distribute-payout
# → round 2: USER2 (slot 2) receives 15 ADA
#    all treasury UTxOs: rounds_paid 2 → 3 (group now mature)

# ── 7. Exit the group (mature exits — full refund, no penalty) ────────────────
ACTIVE_WALLET=USER2 pnpm run exit-group
# → burns USER2 treasury UTxO, remaining ADA returned to USER2

ACTIVE_WALLET=USER1 pnpm run exit-group
# → burns USER1 treasury UTxO, remaining ADA returned to USER1

ACTIVE_WALLET=ADMIN pnpm run exit-group
# → burns ADMIN treasury UTxO, remaining ADA returned to ADMIN

# ── 8. Delete the group ───────────────────────────────────────────────────────
# Edit is_active to false in update-group.ts, then:
pnpm run update-group
# → deactivates group (is_active=false); one-way latch

pnpm run delete-group
# → burns group NFT pair, returns creator_bond to ADMIN
```

---

## Helper scripts

| Script             | Purpose                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `show-wallets`     | Print ADMIN/USER1/USER2 addresses, balances, and DCU tokens                       |
| `generate-wallets` | Generate fresh seed phrases (first-time setup only)                               |
| `send-ada`         | Send ADA between wallets: `FROM_WALLET=ADMIN TO_WALLET=USER1 AMOUNT=5000000`      |
| `deploy-scripts`   | Deploy treasury + group reference scripts (~56 ADA, permanent). Run once.         |
| `reset-state`      | Wipe `state.json` to start a fresh test session                                   |
| `purge-nfts`       | Burn all account/group NFTs held by a wallet (emergency cleanup)                  |
| `cron-daemon`      | Long-running process that auto-submits `distribute-payout` when each round opens. |

---

## Endpoints

### Account

| Script           | Default wallet | What it does                                                      |
| ---------------- | -------------- | ----------------------------------------------------------------- |
| `create-account` | USER1          | Mints an Account NFT. Saves `accountTokenSuffix` to `state.json`. |
| `update-account` | USER1          | Updates email/phone hash on the account UTxO.                     |
| `delete-account` | USER1          | Burns the account NFT and reclaims the locked ADA.                |

### Group

| Script         | Default wallet | What it does                                                                          |
| -------------- | -------------- | ------------------------------------------------------------------------------------- |
| `create-group` | ADMIN          | Creates a group with configured fee parameters. Saves `groupTokenSuffix`.             |
| `update-group` | ADMIN          | Updates editable fields (fees, max_members). Locked once any member has joined.       |
| `delete-group` | ADMIN          | Burns group tokens and reclaims ADA. Requires `member_count=0` and `is_active=false`. |

### Treasury

| Script                     | Default wallet | What it does                                                                                                      |
| -------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `join-group`               | USER1          | Joins the group. Locks `contribution_fee × collateral_rounds` into treasury (PerRound default = 1 round).         |
| `start-group`              | ADMIN          | Seals membership, sets `num_intervals=member_count`, anchors `start_time`. **Required before distribute-payout.** |
| `distribute-payout`        | ADMIN          | Collects contributions and pays the current round's borrower. Permissionless.                                     |
| `claim-payout`             | USER1          | Pull mode: withdraws the borrower's earmarked `claimable_balance` to a wallet (`DESTINATION_ADDRESS` to redirect). |
| `exit-group`               | USER1          | Exits the group (mature = full refund; early = PenaltyState created).                                             |
| `terminate-group`          | ADMIN          | Claims the PenaltyState UTxO after an early exit.                                                                 |
| `contribute`               | USER1          | Tops up a treasury UTxO balance. `TOP_UP_AMOUNT=<lovelace>` (default 5 ADA).                                      |
| `update-payout-credential` | USER1          | Redirects future payouts to the current signing wallet's address.                                                 |
| `extend-grace-window`      | ADMIN          | Extends grace period for `MEMBER_WALLET` (default USER1) in ICS.                                                  |
| `next-cycle`               | ADMIN          | Resets a mature group for another rotation cycle. Members re-deposit, then admin calls start-group again.         |

---

## Cron daemon (`distribute-payout` automation)

The daemon polls an active group on a configurable interval and submits
`distribute-payout` automatically as soon as each round's time gate opens.

```bash
pnpm run cron-daemon
```

Because `distribute-payout` is permissionless the daemon wallet only needs
~5 ADA for collateral and tx fees — it never touches the group's funds.

**Configuration via `.env`:**

```ini
ADMIN_SEED="..."           # Wallet that signs and pays fees (collateral)
BLOCKFROST_KEY="..."       # Or MAESTRO_API_KEY
NETWORK=Preprod

POLL_INTERVAL_SECS=30      # How often to check whether a round is open (default 30)
SUBMIT_COOLDOWN_SECS=120   # Pause after a successful submit before re-checking (default 120)
```

**What happens on each tick:**

1. Reads `groupTokenSuffix` from `state.json`.
2. Fetches the group UTxO and decodes the datum.
3. Checks if `now >= start_time + (last_distributed_round + 1) × interval_length`.
4. If ready: builds, signs, and submits `distribute-payout`, then waits for confirmation.
5. If not ready: logs the wait time and sleeps until the next poll.

**Handled automatically:**

- `OutsideValidityInterval` (clock drift) — retries after `POLL_INTERVAL_SECS`
- All rounds complete (group mature) — logs a message and keeps polling (safe to leave running)
- Network / provider errors — logs the error and retries

Stop with `Ctrl+C` — the daemon finishes the current poll then exits cleanly.

---

## State (`state.json`)

| Key                       | Written by               | Used by                    |
| ------------------------- | ------------------------ | -------------------------- |
| `groupTokenSuffix`        | `create-group`           | All treasury scripts       |
| `groupPolicyId`           | `create-group`           | Staleness check            |
| `groupIntervalLength`     | `create-group`           | Slot schedule display      |
| `groupStartTime`          | `start-group`            | Slot schedule display      |
| `groupNumIntervals`       | `start-group`            | Slot schedule display      |
| `accountTokenSuffix`      | `create-account` (USER1) | `join-group`, `exit-group` |
| `adminAccountTokenSuffix` | `create-account` (ADMIN) | `join-group`               |
| `user2AccountTokenSuffix` | `create-account` (USER2) | `join-group`               |
| `scriptRefTreasury`       | `deploy-scripts`         | `join-group`, `exit-group` |
| `scriptRefGroup`          | `deploy-scripts`         | `join-group`, `exit-group` |

**Never commit `state.json`** — it contains live on-chain identifiers.

---

## Fee structure

**`contribution_fee`** — each member locks `contribution_fee × collateral_rounds` at join (PerRound default = 1 round; top up later via `contribute`).

**`joining_fee`** — one-time fee paid to `admin_payment_credential` at join. Not returned on exit.

**`creator_bond`** — ADA locked in the group UTxO at creation. Returned on `delete-group`.

**`penalty_fee`** — forfeited on early exit (before maturity). Claimable by admin via `terminate-group`.

---

## How slots work

- Members are assigned slots in join order (first joiner = slot 0)
- `start-group` anchors `start_time` and fixes `num_intervals = member_count`
- Round N opens at `start_time + N × interval_length`
- `current_slot = round_number % num_intervals` → that member is the borrower
- After all rounds: **mature exit** (no penalty). Before: **early exit** (penalty forfeited)

---

## Step-by-step manual test (Preprod, 3 wallets)

### Step 0 — Check wallets and fund

```bash
pnpm run show-wallets
```

Fund ADMIN (~150 ADA), USER1 (~50 ADA), USER2 (~50 ADA) at the Preprod faucet.
Wait ~1 minute for confirmation.

---

### Step 1 — Deploy reference scripts (once per SDK version)

```bash
pnpm run deploy-scripts
```

Deploys each validator in its own transaction (both scripts together exceed Cardano's
16,384-byte limit, so they are split: treasury first, group second after confirmation).

- **Tx 1/2** — treasury validator → alwaysFails address, 30 ADA locked, waits ~1 min
- **Tx 2/2** — group validator → alwaysFails address, 26 ADA locked

**alwaysFails address** (Preprod):
`addr_test1wq3vnggra5ljl2tunqkhd4hz4agvt422cvrfswcedj8um2cwsu3l3`

Cost: **~56 ADA total** — permanently locked. ADA cannot be reclaimed, but scripts are
accessible forever. Re-deploy only when the SDK upgrades to new validator hashes.

Re-running is safe — `verifyDeployment` checks the stored OutRefs on-chain and skips
re-deployment if both UTxOs are still valid.

---

### Step 2 — Create accounts (one per wallet)

```bash
ACTIVE_WALLET=ADMIN pnpm run create-account
# → mints Account NFT, saves adminAccountTokenSuffix

ACTIVE_WALLET=USER1 pnpm run create-account
# → mints Account NFT, saves accountTokenSuffix

ACTIVE_WALLET=USER2 pnpm run create-account
# → mints Account NFT, saves user2AccountTokenSuffix
```

---

### Step 3 — Create the group

```bash
pnpm run create-group
# → ADMIN creates group, saves groupTokenSuffix + groupIntervalLength
```

Review `create-group.ts` before running:

- `TEST_MODE = true` → 5-minute intervals, 5-member cap
- `CONTRIBUTION_FEE = 5_000_000n` → 5 ADA/slot
- `JOINING_FEE = 2_000_000n` → 2 ADA one-time

---

### Step 4 — Join the group

Join order determines slot assignment (first = slot 0).

```bash
ACTIVE_WALLET=ADMIN pnpm run join-group   # slot 0
ACTIVE_WALLET=USER1 pnpm run join-group   # slot 1
ACTIVE_WALLET=USER2 pnpm run join-group   # slot 2
```

Each join locks `contribution_fee × collateral_rounds` (5 ADA × 1 = 5 ADA by default, PerRound).
If `scriptRefTreasury` and `scriptRefGroup` are in `state.json`, the tx uses reference
scripts (~4.5 KB) instead of inlining the full validator (~16 KB).

---

### Step 5 — Start the group

```bash
pnpm run start-group
# → is_started=true, num_intervals=3, start_time=<now>
# → saves groupStartTime + groupNumIntervals
# → prints full slot schedule
```

No new members can join after this. The validator rejects further `join-group` calls.

---

### Step 6 — Distribute payouts

Wait for the first 5-minute interval, then:

```bash
pnpm run distribute-payout
# → round 0: ADMIN (slot 0) receives 3 × 5 ADA = 15 ADA

# Wait another 5 minutes:
pnpm run distribute-payout
# → round 1: USER1 (slot 1) receives 15 ADA

# Wait another 5 minutes:
pnpm run distribute-payout
# → round 2: USER2 (slot 2) receives 15 ADA
```

Permissionless — any wallet can call it. Payout always goes to the borrower's stored credential.

---

### Step 7 — Exit the group (mature)

After all 3 rounds are distributed, every exit is a **mature exit** (full refund):

```bash
ACTIVE_WALLET=USER2 pnpm run exit-group
ACTIVE_WALLET=USER1 pnpm run exit-group
ACTIVE_WALLET=ADMIN pnpm run exit-group
```

---

### Step 8 — Delete the group

```bash
pnpm run update-group    # set is_active=false (edit the flag in update-group.ts)
pnpm run delete-group    # burns group tokens, returns creator_bond to ADMIN
```

---

## Early exit + terminate (penalty path)

Exit before maturity to test the penalty flow:

```bash
# After start-group, before all rounds are distributed:
ACTIVE_WALLET=USER1 pnpm run exit-group
# → PenaltyState UTxO created (penalty_fee locked)

MEMBER_WALLET=USER1 pnpm run terminate-group
# → PenaltyState burned, penalty_fee sent to ADMIN
```

---

## Tier 2 flows

### Update payout credential test

Redirect a member's future payouts to a different wallet.

```bash
# Whichever wallet signs becomes the new payout destination.
ACTIVE_WALLET=USER1 pnpm run update-payout-credential
# → USER1's member_payment_credential updated to current wallet's payment key

pnpm run distribute-payout
# → USER1's payout now lands at the updated address
```

### ICS flow (contribute + extend-grace-window)

Engineer InsufficientCollateralState by joining with a reduced deposit.
One member joins with only 1× contribution_fee instead of max_members×, so
their balance hits zero after round 0 and they transition to ICS.

```bash
# ── fresh group setup ──────────────────────────────────────────────────────────
pnpm run reset-state
ACTIVE_WALLET=ADMIN pnpm run create-account   # if not already done
ACTIVE_WALLET=USER1 pnpm run create-account
ACTIVE_WALLET=USER2 pnpm run create-account
pnpm run create-group                          # TEST_MODE: 5 ADA fee, 5-min intervals

ACTIVE_WALLET=ADMIN pnpm run join-group        # slot 0 — normal deposit (25 ADA)
ACTIVE_WALLET=USER1 pnpm run join-group        # slot 1 — normal deposit (25 ADA)
# USER2 joins with minimum deposit: 5 ADA (1× contribution_fee) → will hit ICS after round 0
ACTIVE_WALLET=USER2 TREASURY_DEPOSIT_OVERRIDE=5000000 pnpm run join-group

pnpm run start-group

# ── round 0: ADMIN receives payout, USER2 drops to 0 ADA → ICS ────────────────
pnpm run distribute-payout
# → USER2's treasury: TreasuryState → InsufficientCollateralState (balance < contribution_fee)
# → USER2 now has grace_period_length to contribute before being penalised

# ── admin extends USER2's grace window (optional, up to 2 extensions) ──────────
MEMBER_WALLET=USER2 pnpm run extend-grace-window
# → USER2's grace_expires_at extended by one more grace_period_length

# ── USER2 tops up their treasury UTxO ──────────────────────────────────────────
ACTIVE_WALLET=USER2 TOP_UP_AMOUNT=20000000 pnpm run contribute
# → USER2 back in TreasuryState with sufficient balance for future rounds
```

---

## Negative tests (expected validator failures)

```bash
# Join after group is started → fails: is_started=true
pnpm run start-group
ACTIVE_WALLET=USER2 pnpm run join-group

# Distribute before start-group → fails: "not been started"
pnpm run distribute-payout

# Distribute immediately after start-group → fails: time gate not satisfied
pnpm run start-group
pnpm run distribute-payout   # immediately (< 5 min)

# Update critical field after members joined → fails: field frozen
# (edit contribution_fee in update-group.ts)
ACTIVE_WALLET=ADMIN pnpm run update-group

# Delete active group → fails: must deactivate first
ACTIVE_WALLET=ADMIN pnpm run delete-group
```
