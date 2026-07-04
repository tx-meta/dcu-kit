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

- **Cause:** `pnpm pack` emits `tx-meta-dcu-kit-<v>.tgz`, but the script referenced
  `dcu-kit-<v>.tgz`, so repacks silently kept the previous tarball installed.
- **Fix:** `repack` renames the pack output to `dcu-kit-<v>.tgz`.

---

## B. Feature gaps / capability mismatches (need deliberate design + tests, NOT ad-hoc)

### B1. DefaultState recovery via `contribute` — DONE ✅ (committed `c555fba`)

- **Decision:** keep recovery in `contribute` (mirrors the on-chain single `Contribute`
  redeemer — most modular; no variant/endpoint proliferation, recovery is "a top-up that
  clears the default"). SDK branches on input datum: TreasuryState top-up unchanged;
  DefaultState → TreasuryState reconstruct (preserve slot/rounds_paid/credential/earmark,
  require post-top-up balance ≥ contribution_fee); PenaltyState rejected.
- **Tests:** new emulator test (transition + preserved fields); enforcement already covered by
  the Aiken `contribute__*_default_recovery_*` suite. Validated on Preprod.

### B2. Defaulter resolution — DONE ✅ (treasury hash → 982d5c8d)

- **Implemented.** New `TerminateDefault` treasury redeemer (appended LAST → existing Constr
  indices stable) + `validate_terminate_default`. The admin removes a member stuck in
  DefaultState after their grace window (incl. extensions) has fully expired: burns the
  membership token, decrements member_count, and forfeits the collateral to the admin (flows
  to the admin's wallet as change, exactly like ClaimPenalty). Gates: datum is DefaultState;
  group spending input at the trusted group script with a matching link; group output shows
  member_count − 1 and the member dropped from the registry (self-enforced, so no ghost
  member); admin holds the group (222) token; `get_lower_bound(tx) > grace_expires_at`; exactly
  one membership token burned. The member_count decrement reuses the group `Exit` redeemer
  (permissionless at the group level — authorised by the membership token being spent at the
  treasury), so no group-validator change was needed (group/account hashes unchanged).
- **Aiken:** 9 tests — accept-after-grace; reject before-grace / at-grace-boundary / non-admin /
  no-burn / no-count-decrement / member-left-in-registry / non-DefaultState (fail) /
  fake-group-script (fail, C3). 179 tests / 0 warn.
- **SDK:** `TerminateDefault` in TreasuryRedeemerSchema; `terminateDefault` endpoint (admin-gated,
  spends group with Exit + treasury with TerminateDefault, burns, slot-aligned validFrom for the
  grace gate, plain completeProgram so emulator UPLC enforces it); wired into `createDcuSdk`. e2e
  test: member defaults after round 0 → advance past grace → admin terminates → member_count 2→1,
  member removed from registry. 35 SDK tests pass.
- **Sub-decision (forfeited collateral):** admin-claim (simple), as recommended. Pro-rata
  redistribution to shorted members is a future enhancement.
- **Preprod:** redeploy pending (shared with B3). Re-run e2e after deploy.

<details><summary>Original B2 spec (for reference)</summary>

#### B2. Defaulter resolution — SPEC'D (validator change → redeploy)

- **Problem:** a DefaultState member who never recovers (grace + extensions expired) has no
  resolution path; they sit in the group forever.
- **Decision (fair design):** the admin can **terminate a defaulter after grace expires** —
  burn their membership, decrement `member_count`, and forfeit their remaining collateral as
  the penalty. Time-gated (`get_lower_bound(tx) > grace_expires_at`), so it is neutral (not
  arbitrary admin power) and fair (grace + extensions were offered first).
- **On-chain work:**
  - Treasury redeemer: either extend `ClaimPenalty` to accept a `DefaultState` input gated on
    grace expiry, or add a `TerminateDefault` variant (append LAST to keep Constr indices
    stable). Mint handler burns the member tokens; spend handler verifies `now > grace_expires_at`,
    admin auth, member_count decrement on the group output, and routes the forfeited balance
    (to admin, or — future — pro-rata to shorted members).
  - Aiken tests: accept-after-grace, reject-before-grace, reject-non-admin, balance routing.
- **Offchain:** new `terminateDefault` (or extended `terminateGroup`) endpoint + emulator test.
- Open sub-decision: forfeited collateral → admin (simple) vs pro-rata to underpaid members
  (fairer, more complex). Recommend admin-claim now, pro-rata as a later enhancement.

</details>

### B3. min-ADA last-round gap for ADA-contribution groups — DONE ✅ (treasury hash → f2ba562a)

- **Implemented on-chain.** `dcu/treasury_utils` adds `min_ada_reserve = 2_000_000` and a
  `contributable_in(value, policy, name)` helper (= `lovelace − reserve` for ADA assets, raw
  balance for native tokens). Applied at 5 validator sites in `treasury_validation.ak`:
  join floor (`fees_locked`), distribute conservation + ICS threshold (`input_bal`/`output_bal`),
  contribute recovery (`recovery_funded`), next-cycle refund guard (`refunded`), and exit penalty
  floor (`penalty_fee_locked`). The −fee conservation is reserve-invariant (the reserve cancels);
  only the floor/threshold sites change, so the final round drains contributable to 0 while the
  reserve keeps the membership token's min-ADA covered.
- **Aiken:** existing ADA fixtures bumped by the reserve (contributable preserved); 2 new tests —
  `distribute_round__accepts_final_round_drains_to_reserve` (the core fix) and
  `join_group__rejects_deposit_without_reserve` (floor now requires the reserve). 170 tests / 0 warn.
- **SDK:** `MIN_ADA_RESERVE` + `contributableBalance` in `core/utils/treasury.ts`. joinGroup ADA
  deposit = `collateralFloor + reserve`; distribute ICS threshold and contribute recovery measure
  contributable; exit penalty uses the named constant. Also fixed a latent coin-selection gap
  exposed by the larger deposits: exitGroup now explicitly returns the account (222) token to the
  member's wallet (appended AFTER the penalty/burn output so penalty_output_index is unchanged).
  34 SDK tests pass. ExtendGrace/recovery tests now reach DefaultState via the natural PerRound
  path (default deposit, no thin override — a thinner deposit is correctly rejected by the floor).
- **Preprod:** redeploy pending (shared with B2). Re-run the full e2e after both land.

<details><summary>Original B3 spec (for reference)</summary>

#### B3. min-ADA last-round gap for ADA-contribution groups — NEEDS FIX

- **Cause:** distribute pins `output_bal == input_bal − contribution_fee` in the contribution
  asset (= lovelace for ADA groups). On the final round a member at exactly `contribution_fee`
  must output **0 lovelace**, colliding with min-ADA (~1.3 ADA for the token-bearing UTxO) →
  validator rejects. Any ADA-group member who funds exactly `num_rounds × fee` fails the last
  round. (Native-token groups are unaffected — token balance is separate from min-ADA.)
- **Decision (production-grade):** fix **on-chain** — the validator measures a _contributable_
  balance = `lovelace − MIN_ADA_RESERVE` (a fixed constant ≥ real treasury min-ADA, e.g. 2 ADA),
  so correctness does not depend on how the tx is built (a direct API caller can't underfund).
  The SDK deposit-floor mitigation was rejected as a band-aid.
- **On-chain work (touches the core conservation math — high care):**
  - Define `MIN_ADA_RESERVE` (or derive). Apply `contributable = lovelace − reserve` consistently
    in: join floor (`≥ fee × collateral_rounds + reserve`), distribute conservation
    (`out_contributable == in_contributable − fee`), ICS threshold, exit refund, and
    `recovery_funded`. The treasury UTxO always retains `reserve` lovelace for its token.
  - For native-token groups the contribution asset is already separate from lovelace — keep the
    reserve concept ADA-only so token groups are unaffected.
  - Aiken tests: last-round to exactly-reserve accepted; below-reserve rejected; join floor;
    exit refund nets the reserve back.
- **Offchain:** join/contribute/distribute deposit + balance math updated to match; e2e re-run.
- **Confirmed on Preprod:** 3-member, 15 ADA (=3×5) deposits → round 2 crashed; a group with
  headroom (balances staying above min-ADA) distributes the final round fine.

</details>

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
DefaultState recovery\*), extend-grace-window, update-payout-credential, update-group, delete-group.

Pending: update-account, delete-account, next-cycle.

\* via the B1 prototype.
