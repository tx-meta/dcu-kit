# P2 Acceptance Matrix — ROSCA/escrow launch surface (frozen hashes)

Status: SKELETON — the P2 session fills every evidence cell. On completion this
becomes part of the tracked P2 evidence bundle (own commit, Harun-approved).
Deployment identity for every row = the P2 deployment manifest (git commit,
registry checksum, settings NFT unit, script hashes, ref-script out-refs).

Scope decisions (Harun, 2026-07-17):
- Audit wave 1 covers escrow **v1 AND v2/pool/project** (R7 scope: v2 folded into
  the one escrow audit).
- Escrow ON-CHAIN bytes are unchanged by P1 (verified byte-identical), and the two
  post-sweep escrow fixes (7fe15be, cefebe1) were offchain-only — so the 2026-07-11
  live sweep evidence for escrow v2/pool/project validators STANDS. P2 escrow work =
  SDK smoke on the changed offchain paths + citation of existing evidence, not a
  full re-sweep. ROSCA (new group/account hashes) gets the full live matrix on the
  fresh deployment.
- Every negative case needs TWO proofs where an SDK guard exists:
  (a) SDK proof — endpoint returns the typed error before tx construction;
  (b) validator proof — raw harness bypasses the guard, provider evaluation
      rejects; preserve evaluator error + attempted datum + deployment hash +
      timestamp + confirmation the seed/group UTxO stayed unspent (no tx hash
      exists for a rejected tx).

Columns: Initial state · Command/example · Expected · Resulting state · Evidence
(tx hash or rejection record) · Validator/deployment hash · Status.

## A. Deployment (fresh protocol instance)

Deployment identity for every row below: manifest `docs/deployments/2026-07-17-preprod-p2.json`
(git 076302227, sdk 0.5.5, tarball sha256 3636ef7d…, registry sha256 5f744620…).
Settings policy `138efe0f…`; deploy address `addr_test1wq3vnggra5ljl2tunqkhd4hz4agvt422cvrfswcedj8um2cwsu3l3`.

Hash note (important): the registry stores settings-INDEPENDENT sha256 fingerprints
of each validator's unapplied compiledCode (group `9ba3202a…`, account `ae548bb5…`).
The account validator is unparameterized, so its APPLIED script hash `7fd4e55c…` is
also settings-independent and equals the P1-declared account hash — that equality is
the real cross-check that the P1 account-datum change produced the expected bytes. The
group and treasury validators are parameterized by the settings policy, so their
applied hashes (group `3cfdf8bf…`, treasury `0ba6478f…`) are specific to THIS
deployment's settings policy and are not fixed across deployments. E1 verifies each
by comparing the on-chain reference-script CBOR against the CBOR locally derived from
settings policy `138efe0f…`.

| # | Operation | Expected | Evidence | Status |
|---|---|---|---|---|
| A1 | initialize-settings (settings NFT `138efe0f…73657474696e6773` pinning account `7fd4e55c…`, group `3cfdf8bf…`, treasury `0ba6478f…` + 4 stake hashes) | settings UTxO at always-fails, datum consistent | init tx `674395645bfbfae2…`; E1 settings check consistent | ☑ |
| A2 | deploy-scripts: 6 reference scripts | 6 out-refs recorded | treasury `32ed531d…#0`, group `880b9141…#0`, rounds `b29e7092…#0`, lifecycle `fae7e405…#0`, recovery `76c7e812…#0`, reserve `39ea5fb7…#0` | ☑ |
| A3 | 4 treasury-family stake registrations | all 4 registered | rounds `b4fadeef…`, lifecycle `6db6bdde…`, recovery `62733b51…`, reserve `525f46bf…`; E1 all `registered` | ☑ |
| A4 | Deployment manifest written (tracked; no secrets) | manifest committed | `docs/deployments/2026-07-17-preprod-p2.json` | ☑ |

## B. ROSCA positive lifecycle (new hashes — full live run)

| # | Operation | Expected | Evidence | Status |
|---|---|---|---|---|
| B1 | create-account (default, no commitment) | datum profile_commitment == "" | account `34bca0e7…` tx `f507ffed…`; on-chain commitment read back == "" | ☑ |
| B2 | create-account (with computeProfileCommitment) | commitment on-chain | USER1 account `b314ee9c…` tx `5bf42bf6…` (with commitment); on the new account policy `7fd4e55c…` — first live proof of the P1 account-datum change | ☑ |
| B3 | update-account (omitted) | commitment PRESERVED | account `e2e1808e…` create `722e155a…`, update-omit `6a34705a…`; commitment `9e2f3a5c…` unchanged before/after | ☑ |
| B4 | update-account ("" ) | commitment cleared | account `e2e1808e…` clear tx `ffe2aba0…`; commitment read back == "" | ☑ |
| B5 | create-group (envelope-satisfying config, threshold=majority, timelock/recommit=86_400_000) | group created | recovery group `58aab8c8…` tx `7511f7b4…` (recovery_timelock=recommit_window=86_400_000); recommit group `40e8ca8e…` tx `117c9f44…` | ☑ |
| B6 | update-group pre-join (config change within envelope) | accepted | group `88608c45…` (USER1): create `2d82ef99…`, update `3662358a…` (fee 5→4 ADA, timelock floor→2d), datum read back verified | ☑ |
| B7 | join-group ×N (incl. joining fee routing) | member_count=N | recovery group: ADMIN `6df9275d…` slot 0, USER1 `c1df6b64…` slot 1 → member_count=2 | ☑ |
| B8 | start-group | sealed, slots assigned | recovery group start tx (start_time 2026-07-17T11:36:01Z, num_rounds=2) | ☑ |
| B9 | contribute | deposit accepted | recommit group: `19aaec57…` (member 1053643c…), `54a83473…` (member 924fe76f…) | ☑ |
| B10 | distribute-payout (round 0, then sequential) | pot paid per mode | recommit group: round 0 `a8447fef…`, round 1 (lap boundary) `bf0dc412…` (Push mode) | ☑ |
| B11 | claim-payout (Pull mode group) | earmark withdrawn | | ☐ |
| B12 | update-payout-credential | credential rotated | | ☐ |
| B13 | extend-grace-window / terminate-default | grace then removal | | ☐ |
| B14 | begin-recommit → free exit during window → re-seal. | era advances | **CLOCK B, mostly done day 1**: start_time 2026-07-17T12:21:02Z; rotation lap complete (B9/B10); begin-recommit `566a9ddb…` opened the window; free exit `3585aa0f…` + window join `652036d5…` both ran INSIDE the window (member_count back to 2). ONLY the re-seal (start-group) remains, valid ≥2026-07-18T12:21:02Z (day 2). | ◑ re-seal day 2 |
| B15 | propose-recovery (day 1) → approve → execute. Datum stays `recovery_timelock = 86_400_000`; ACT at least 25h after PROPOSAL time. | identity rotated N→N' | **CLOCK A ARMED day 1**: propose `f055c0d1…` (USER1 `b314ee9c…` lost → USER2 `ad864b57…` recoveree); approval collected at propose time (APPROVER_WALLETS=ADMIN), RecoveryRequest.approvals=[ADMIN 18b47e8e…], quorum=1 met. `earliest_execution_slot=1784374635000` → **execute valid 2026-07-18T11:37:15Z (day 2)**. Snapshot `sdk/examples/evidence/p2-recovery-group-snapshot.json` | ◔ armed, execute day 2 |
| B16 | cancel-recovery (separate request) | request burned | recovery group `58aab8c8…`: second request propose `ff312f0f…` (target ADMIN `18b47e8e…`) then cancel `2ddfc795…` — request burned, leaving the original day-1 request untouched | ☑ |
| B17 | top-up-reserve / reserve cover path | reserve balance moves | recommit group `cb57d564…`: top-up `4bc0c3ba…`, reserve balance 0 → 2000000. (Fixed an example gap: top-up-reserve.ts passed only the treasury ref, needed the full scriptRefs.) | ☑ |
| B18 | assign-admin (incl. script-held admin variant) | admin token moved | | ☐ |
| B19 | exit-group (mature) → terminate-group → delete-group | group burned, bond returned | | ☐ |
| B20 | delete-account | account pair burned | | ☐ |

## C. ROSCA negative proofs (SDK + validator, per scope rule above)

| # | Case | SDK proof | Validator proof | Status |
|---|---|---|---|---|
SDK-guard half (a) is network-independent (the guard runs before any I/O): verified
by the guard code (`createGroup.ts` ConfigurationError, `createAccount.ts`
TransactionBuildError) and the emulator control tests in
`sdk/test/negativeProofs.test.ts`. Validator half (b) is captured LIVE on the fresh
deployment via `negative-proofs.ts` (provider evaluation, never submitted; evidence
in `sdk/examples/evidence/negative-proofs/`, each record carries evaluator error +
attempted datum + deployment id + timestamp + seed-unspent confirmation).

| C1 | create-group recovery_threshold = 1 | ConfigurationError (guard + emulator test) | LIVE rejection `C1-2026-07-17T12-24-51…json`, seedUnspentAfter=true | ☑ |
| C2 | create-group recovery_timelock = 86_399_999 | ConfigurationError | LIVE rejection `C2-2026-07-17T12-24-57…json`, seedUnspentAfter=true | ☑ |
| C3 | create-group recommit_window = 0 | ConfigurationError | LIVE rejection `C3-2026-07-17T12-25-03…json` | ☑ |
| C4 | pre-join update-group lowering timelock below floor | (no SDK guard on updateGroup — validator proof only) | LIVE rejection `C4-2026-07-17T13-34-03…json` on group `88608c45…` | ☑ |
| C5 | pre-join update-group mutating CIP-68 version / emptying name | — | LIVE rejections `C5-…13-34-10…json` (version=2) + `C5-…13-34-16…json` (empty metadata) on group `88608c45…` | ☑ |
| C6 | create-account 31-byte commitment | TransactionBuildError | LIVE rejection `C6-2026-07-17T12-25-08…json`, seedUnspentAfter=true | ☑ |
| C7 | premature execute-recovery (before timelock) | — | LIVE rejection `C7-2026-07-17T13-28-48…json`: execute-recovery on the armed request (earliest valid 2026-07-18T11:37:15Z) rejected at evaluation ~22h early, never submitted | ☑ |
| C8 | premature re-seal (before recommit window) | — | LIVE rejection in `p2-recommit-lap.json`: begin-recommit `566a9ddb…` opened the window, immediate re-seal attempt rejected at evaluation (~23h before start_time+window), never submitted | ☑ |
| C9 | join beyond max_members | TransactionBuildError (eval) | LIVE rejection `C9-*.json`: group `88608c45…` filled to max_members=2 (joins `3f687f1a…`+`e041e233…`), third join (ADMIN acct `34bca0e7…`) rejected at evaluation | ☑ |

## D. Escrow (bytes unchanged — machine-verifiable reuse + targeted smoke)

| # | Item | Basis | Status |
|---|---|---|---|
| D1 | v1 create/release/reclaim/abort validator evidence | prior sweeps — CITE tx hashes + their deployment identity | ☐ |
| D2 | **Machine-verifiable reuse bundle**: prior sweep tx hashes + deployment identity · prior validator fingerprints · current fingerprints · explicit equality result · the two SDK-only commit ids (7fe15be, cefebe1) with changed-file lists · pointer to D3/D4 smoke | `sdk/examples/evidence/d2-escrow-reuse-bundle.json`: escrow fingerprints **IDENTICAL** sweep-era (b80c418) vs HEAD; 7fe15be + cefebe1 both `onchainTouched: false`; b80c418 fmt-only (bytecode identical). Escrow bytecode byte-identical to the 2026-07-11 sweep → sweep evidence stands. | ☑ |
| D3 | ☑ DONE — `d3-skip-smoke.json`: all four (escrow-v1/v2, pool, project) scriptRefFirst=true, endpoint skipped it, scriptRef unspent after. Deterministic prep (out#0 scriptRef, out#1 seed). ORIG:  SDK smoke on ALL FOUR 7fe15be endpoints: escrow-create, **escrow-v2-create**, pool-create, project-create. Old logic was `sortUtxos(wallet)[0]`, so the skip is provable DETERMINISTICALLY: use a dedicated test wallet whose entire UTxO set is one prep tx with output#0 = pay-to-self WITH scriptRef and output#1 = ordinary seed — same txid, so out-ref sort puts the scriptRef UTxO first by output index, no retries. Fresh prep tx before EACH endpoint run (the change output breaks determinism otherwise). Evidence per run: (1) the wallet's full sorted UTxO set, (2) scriptRef UTxO first in sort order, (3) endpoint skipped it, (4) selected ordinary seed recorded, (5) scriptRef UTxO unspent after. | one live run each, deterministic skip evidence | ☐ |
| D4 | SDK smoke: pool-allocate with a **nonzero** computed `pool_ref_index` — if the anchor sorts first, the old hardcoded 0 would also pass. Against the deployment's FIXED reference txids, a fresh anchor's sort position is NOT ~50% (it depends on where the fixed txid sits in the 256-bit range): bound attempts at EIGHT, re-creating the anchor each time; if none sorts nonzero, FAIL the smoke explicitly rather than retrying indefinitely. Record every attempt's out-refs and sorted order, the final computed index, and recover/close unused anchors where possible (record any that cannot be). | one live run with index > 0, bounded attempts | ☐ |

## E. Cross-cutting

| # | Item | Status |
|---|---|---|
| E1 | **Full identity chain verified via NEW `verifyProtocolDeployment`** (read-only; `verifyDeployment` retained for compatibility): all six reference UTxOs exist · each at the deployment address · each holds the exact expected applied-script CBOR · reported ledger hashes match locally derived · settings NFT at the always-fails address · settings datum matches account/group/treasury + 4 stake hashes (`verifySettings`) · manifest out-refs + settings unit + network agree · registry fingerprints match bundled blueprints. Stake REGISTRATION is checked read-only (provider account query), never by attempting an idempotent registration tx — mutation stays in a separate `ensureTreasuryStakeRegistered`-style op. This is an SDK artifact change: normal review + tests, full CI rerun, final commit + tarball checksum re-recorded in the manifest (does not invalidate the on-chain adversarial review). **DONE 2026-07-17: `verify-protocol-deployment.ts` returned ok — 6/6 refs CBOR+hash, settings datum consistent, 4/4 stake registered, registry fingerprints match. Evidence `sdk/examples/evidence/verify-protocol-deployment-2026-07-17T09-13-51-497Z.json`. First run misreported stake registrations (Blockfrost `active` vs `registered`); fixed in PR #84, re-verified green.** | ☑ |
| E2 | All B/C rows reference the manifest's deployment id; manifest includes the packed-tarball checksum (script hashes do not prove offchain SDK identity) | ☑ manifest records tarball sha256 3636ef7d… + git 076302227 |
| E3 | Old Preprod instances untouched and still resolvable | ☑ prior settings policy `f90df179…` untouched; old state backed up to `sdk/examples/state.json.bak-2026-07-17` |
