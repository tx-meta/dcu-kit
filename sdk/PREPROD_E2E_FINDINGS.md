# Preprod E2E Test Findings

Working log of everything surfaced while manually exercising every SDK endpoint on
Preprod (via `sdk/examples`). Goal: fix all of these **deliberately and seamlessly after
the test pass** — not reactively mid-test. Each item lists root cause, current status, and
the proper follow-up.

Toolchain note: run with **Node 24** + **pnpm 10** (`~/.local/share/pnpm/pnpm`); lucid pinned
to **0.4.31** (0.5.x has a RedeemerBuilder index regression). See `memory/`.

---

## A. Confirmed bugs

### A1. `group_ref_input_index` hardcoded to `0n` — FIXED ✅ (committed `f55123f`)
- **Where:** `contribute.ts`, `claimPayout.ts`, `extendGraceWindow.ts`, `terminateGroup.ts`.
- **Cause:** redeemer hardcoded the group's position in `reference_inputs` as 0. P5 added the
  settings UTxO as a second reference input; reference inputs are canonically sorted by txHash,
  so the group is no longer at index 0. When settings sorts first, the validator reads settings
  as the group → `Script(group_policy)` check fails → crash. Deterministic on Preprod,
  nondeterministic in the emulator (random txHashes — the "flakiness").
- **Fix:** `referenceInputIndex()` helper (`core/utils/resolve.ts`) computes the canonical index.
- **Validated on Preprod:** contribute, claimPayout, terminateGroup, extendGraceWindow all pass.

### A2. distribute `grace_expires_at` slot-misalignment — FIXED ✅ (uncommitted, validated)
- **Where:** `distributePayout.ts` (ICS/DefaultState transition).
- **Cause:** `grace_expires_at` was `validFrom + grace_period_length` with `validFrom = Date.now()
  − buffer` (not slot-aligned). The validator pins `grace_expires_at == get_lower_bound(tx) +
  grace_period_length`, and the tx lower bound is slot-rounded → up to ~1s mismatch → DefaultState
  output datum rejected. Only hit on an ICS transition (happy path uses an inequality).
- **Fix:** slot-align `validFrom` to the 1000ms grid for live networks, matching the existing
  `exitGroup` pattern (`config.currentTime !== undefined ? raw : raw - (raw % 1000n)`).
- **Validated on Preprod:** distribute that transitions a member to DefaultState now succeeds.
- **Follow-up:** consider centralising the slot-align into a shared util used by exitGroup +
  distributePayout (currently duplicated) so future endpoints don't re-derive it.

### A3. `examples:setup` installs a stale tarball — FIXED ✅ (committed `aae1e34`)
- **Cause:** `pnpm pack` emits `tx-meta-dcu-sdk-<v>.tgz`, but the script referenced
  `dcu-sdk-<v>.tgz`, so repacks silently kept the previous tarball installed.
- **Fix:** `repack` renames the pack output to `dcu-sdk-<v>.tgz`.

---

## B. Feature gaps / capability mismatches (need deliberate design + tests, NOT ad-hoc)

### B1. DefaultState recovery via `contribute` — PROTOTYPED ⚠️ (uncommitted; needs proper treatment)
- **Gap:** the validator supports `DefaultState → TreasuryState` recovery (`recovery_funded`,
  `treasury_validation.ak`), but `contribute.ts` rejected any non-TreasuryState input.
- **Current state:** a working implementation was added mid-test to unstick a member and was
  validated on Preprod (USER1 recovered). **This was scope creep** — it is a prototype, not a
  reviewed feature. Treat it as a spec'd change: design note, unit tests (emulator), negative
  tests (underfunded recovery, PenaltyState rejection), then commit.
- **Decision needed:** keep recovery in `contribute`, or expose as its own `recoverDefault`
  endpoint for clarity.

### B2. DefaultState members cannot `exit` — DESIGN DECISION NEEDED
- `exit-group` requires `TreasuryState`. A defaulted (DefaultState) member's only exits are
  recover-via-contribute (B1) or admin termination. There is no direct DefaultState exit path.
- **Decision needed:** allow DefaultState in exit-group (burn path), or document termination as
  the only route, or add a dedicated endpoint.

### B3. min-ADA last-round gap for ADA-contribution groups — NEEDS FIX
- **Cause:** distribute pins `output_bal == input_bal − contribution_fee` in the contribution
  asset (= lovelace for ADA groups). On the final round a member at exactly `contribution_fee`
  must output **0 lovelace**, colliding with min-ADA (~1.3 ADA for the token-bearing UTxO) →
  validator rejects. Any ADA-group member who funds exactly `num_rounds × fee` fails the last
  round. (Native-token groups are unaffected — token balance is separate from min-ADA.)
- **Options:** (a) SDK join/deposit floor reserves min-ADA on top of `fee × collateral_rounds`;
  (b) validator measures a contributable balance = `lovelace − minAdaReserve`. (a) is no-redeploy.
- **Confirmed on Preprod:** 3-member, 15 ADA (=3×5) deposits → round 2 crashed; a group with
  headroom (balances staying above min-ADA) distributes the final round fine.

### B5. `update-account` / `delete-account` ignore `ACTIVE_WALLET` — EXAMPLE BUG
- Both read `accountTokenSuffix` (USER1's) from state.json directly instead of mapping via
  `accountSuffixKey(ACTIVE_WALLET)` like create-account/join do. So `ACTIVE_WALLET=USER2
  delete-account` actually targeted USER1's account (correctly rejected — USER1 had active
  membership). Fix: resolve the suffix via `accountSuffixKey(activeWallet)` in both examples.
  (SDK behaviour is correct; this is examples-only.)

### B4. exit/join confirmation-spacing — NEEDS FIX
- `join-group` and `exit-group` resolve the group UTxO fresh and don't await the previous tx's
  confirmation. Sequential ops on the shared group UTxO race → `BadInputsUTxO` (observed on
  back-to-back exits). Workaround during tests: manual wait between calls.
- **Fix:** internal `awaitTx` (or tx-chaining) for group-mutating endpoints, or document that
  callers must confirm between sequential group operations.

---

## C. Behavioural notes (not bugs — doc/UX)

- **distribute round 0 is immediate.** Round N opens at `start_time + N × interval_length`; round
  0's gate is `start_time` itself (submittable after the ~120s live validity buffer, **not** a
  full interval). The examples README's "wait 5 minutes then distribute round 0" is
  over-conservative — only rounds 1+ need the interval.
- **Push vs Pull payout** is correctly modelled as the `PayoutMode { Push | Pull }` sum type
  (keep; do not rename to Claim|Distribute, do not collapse to a boolean).

---

## D. Endpoint coverage (Preprod, this session)

Validated: initialize-settings, deploy-scripts, create-account, create-group (Push + Pull),
join-group, start-group, distribute-payout (Push r0/r1, Pull earmark, ICS transition),
claim-payout, exit-group (mature + early/penalty), terminate-group, contribute (TreasuryState +
DefaultState recovery*), extend-grace-window, update-payout-credential, update-group, delete-group.

Pending: update-account, delete-account, next-cycle.

\* via the B1 prototype.
