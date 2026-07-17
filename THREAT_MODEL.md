# DCU Toolkit — Threat Model

Version-controlled trust-boundary and threat model for the DCU Toolkit
protocol (on-chain validators) and SDK. Auditors: start here, then the
per-family design specs in `docs/design-specs/`.

Status date: 2026-07-16. Families: `rosca` (launch), `escrow` (launch),
`savings` (experimental), `governance` (experimental). The machine-readable
launch surface is `validator-registry.json`; the rules for changing it are
in `VERSIONING.md`.

## 1. System boundaries

```
[User wallet(keys)] → [SDK (tx construction)] → [Cardano node/provider] → [Validators (enforcement)]
                          ↑                            ↑
                    [npm registry]              [Blockfrost/indexer]
                          ↑
                 [GitHub repo + CI (build/publish)]
```

Trust boundaries, outermost first:

| Boundary | Inside | Threats considered |
|---|---|---|
| On-chain validators | Aiken scripts, immutable per hash | Malicious tx construction by ANY party. This is the only layer that enforces anything; everything else is convenience. |
| SDK | tx building, datum parsing, endpoint logic | Wrong/hostile inputs, stale chain state, provider lies. The SDK is NOT a security boundary — raw transactions bypass it. |
| Provider (Blockfrost) | chain queries | Stale or wrong data → failed txs, not fund loss (validators still enforce). Availability is a liveness risk only. |
| Build + publish | GitHub CI, npm | Supply-chain: a tampered package could build fund-stealing txs. Mitigations: required CI checks, SHA-pinned actions, gitleaks, pnpm audit, npm provenance, SBOM, `files: ["dist"]`, validator registry gate. |
| Keys | user wallets; CI `NPM_TOKEN`; Preprod keys in untracked `.env` | Key theft = loss of that principal's authority, bounded by on-chain rules (e.g. quorum, timelocks). No key material is committed (full-history scan 2026-07-16). |

## 2. Actors and authority

One on-chain authority model repo-wide: authority is a **Credential or
token possession, never a raw vkey list** (see `terminology-standard`).

| Actor | Authority | Bounded by |
|---|---|---|
| Member | own Account NFT (CIP-68 222) + own treasury/share UTxOs | validators: own-state transitions only |
| Creator | creator Credential on group settings | allowlisted mutable fields only; cannot touch member funds |
| Quorum (escrow pool / savings) | `quorum: Credential` socket | privileged actions listed per family; CANNOT withdraw member savings |
| Governance instance | gate script credential set as a vault's quorum | decision token: genuine, target-bound, one-shot burn |
| Verifier (escrow) | attestation authority only | never holds funds |
| Crank (anyone) | permissionless progress txs | conservation + completeness checks (anti-skim) |

## 3. Assets at risk

1. Member contributions (ROSCA treasuries, savings shares) — the crown jewels.
2. Escrow deposits and pool funds.
3. Reserve/bond pots.
4. Min-ADA locked in state UTxOs (griefing target, not theft target).
5. Off-chain: npm package integrity, repo integrity, provider keys.

## 4. Known accepted risks (by decision, with rationale)

- **Mechanism-design floor:** a pseudonymous defaulter cannot be forced to
  pay beyond what is pre-locked; reserve cover degrades pro-rata when dry.
- **Recovery is social consensus** — quorum + timelock + veto, not
  cryptographic proof of key loss.
- **Escrow verifier honesty** is a trust assumption; bounded (authority-only,
  never custodial).
- **`localUPLCEval: false` for `distributePayout`** — emulator blind spot;
  covered by Aiken unit tests + Preprod runs.
- **Enterprise-address payouts** — payout credential indexing must be by
  payment credential (frontend requirement, documented 2026-07-05).
- **AccountDatum raw PII** (`display_name`, `contact`) — open finding,
  scheduled for the pre-audit hash bundle (roadmap P1). Not accepted
  long-term.

## 5. Family status (security)

| Family | State | Notes |
|---|---|---|
| rosca | Preprod-proven, self-reviewed, awaiting external audit | last-call hash bundle (config envelope, PII) pending before audit |
| escrow | Preprod-proven incl. v2/pool | folded into the same audit wave |
| savings | emulator-proven only; NEVER on a real network | charter mutability hole open (quorum can rotate itself) — blocked on validator split |
| governance | criticals remediated 2026-07-16 (vote uniqueness via voter-record UTxOs + roster; (policy,name) target binding; validity-interval enforcement; charter invariants) | UNMERGED; needs adversarial re-review + external audit before real funds |

## 6. Out of scope (regulatory boundaries, not threats)

Event-triggered claim payouts (insurance), deposit-taking (SACCO FOSA),
public fractional asset offerings (securities). See the roadmap's
OUT OF BOUNDS list.
