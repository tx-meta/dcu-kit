# ADR-0001: ROSCA reserve cover across a halted recommit

- Status: Accepted
- Date: 2026-08-09
- Scope: ROSCA group and treasury validator family

## Context

Terminating a defaulter removes their slot without repacking the current era and
adds the remaining rounds in that era to the reserve's `standin_rounds`. If the
removed member owns the next payout slot, distribution halts immediately while
the positive counter previously prevented `BeginRecommit`. No distribution could
then drain the counter, leaving wind-down as the only reachable transition.

Distribution also allowed the reserve input to be omitted when
`reserve_round_levy == 0`. A hand-built transaction could therefore skip a dry
stand-in decrement even though the first-party SDK included the reserve.

Every group already mints exactly one deterministic reserve token in its create
transaction (`group_reserve_minted`), so requiring that reserve during
distribution cannot strand a valid group that never had one.

## Decision

1. `standin_rounds` represents a communal subsidy for the next N successful
   distributions. It is not a debt assigned to a named member.
2. Every successful distribution spends and continues the group's authenticated
   reserve UTxO. It routes the configured levy and decrements a positive counter
   exactly once, including when both the available draw and levy are zero.
3. `BeginRecommit` normally requires `standin_rounds == 0`. It may carry a
   positive counter only when the next era-relative slot is absent from the
   authenticated member-slot registry, proving distribution is halted.
4. The counter is unchanged by `BeginRecommit` and `StartGroup`. It continues to
   drain under the same distribution rule after the group is resealed.
5. The recommit opt-out window may change membership. Cover funded under the old
   roster may therefore benefit members who join afterward. This is intended.
6. Carried cover may exceed the new era's member count and spill across lap
   boundaries. This is intended; the counter counts distributions, not eras.
7. An admin may terminate the next-slot defaulter and thereby open an early
   recommit. This is accepted and bounded by the existing termination time gate,
   the all-remaining-members-clean gate, and the recommit opt-out window.
8. Wind-down and deletion may retire unresolved cover. The existing reserve-close
   path intentionally does not require the counter to reach zero.

## Rejected alternatives

- An atomic `terminate-and-recommit` transition adds a second lifecycle path and
  duplicates existing authorization and preservation logic.
- Rebasing the remaining slot schedule changes payout order inside a live era.
- Binding cover to the terminated member requires a new datum model and conflicts
  with the reserve's communal-loss-sharing purpose.
- Adding a `cover_pending` field to `GroupDatum` is reserved as a resource-budget
  fallback only. It is unnecessary if the mandatory reserve transaction remains
  within the measured network limits.

## Safety and release gates

- Cross-transition tests must cover a vacant next slot with positive cover, a
  full roster with positive cover, and omitted reserve legs at zero/non-zero levy.
- The N=20 reserve-active distribution is measured against the active network
  limits. Abort the mandatory-reserve design if memory or CPU exceeds 80% of the
  transaction limit, or serialized transaction size exceeds 90%.
- All ROSCA validator hashes and SDK blueprints are updated as one release wave.
  Existing UTxOs remain governed by their old hashes and require pinned tooling
  or explicit wind-down; there is no automatic state migration.
- Exact-hash Preprod lifecycle rehearsal and independent review are required
  before a Mainnet release.

## Wave-1 measurements

Measured on Aiken v1.1.22 with the repository's active Preprod limits
(`maxTxExMem = 16,500,000`, `maxTxExSteps = 10,000,000,000`,
`maxTxSize = 16,384`):

| N=20 distribution      |             Memory |                   CPU | Serialized size |
| ---------------------- | -----------------: | --------------------: | --------------: |
| Dry mandatory reserve  | 10,489,102 (63.6%) | 3,241,829,376 (32.4%) | 7,287 B (44.5%) |
| Levy + active stand-in | 10,531,168 (63.8%) | 3,256,507,411 (32.6%) |               — |

The active-stand-in probe is below all abort thresholds, so the
`cover_pending` Plan B is not activated. The size measurement uses the complete
N=20 dry-reserve SDK transaction with reference scripts; execution-unit figures
use the real withdraw validator through the Aiken scale harness.

## Hash and Preprod migration record

SDK `0.6.1-preprod.0` contains the candidate family. The hashes below are stated
**under the legacy settings policy `138efe0f…`**, which is the only basis on
which "unchanged" is meaningful:

| Component                          | Existing Preprod                                           | Wave-1 candidate (legacy settings policy)                  |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| Applied group policy               | `3cfdf8bf653ca8be1af605e4df4f00433f704ab0172e420b54209416` | `9f3cf4e446fe912fe57750a91612d1017e7de33cf6eb35e3fc4090d8` |
| Applied treasury-rounds stake hash | `4689e405085170a8cf03ac1b6bb88bf1a3c048bed603e5564f344d15` | `7f37fc638b12e1ad429c65f0a7d177f9c77edad912a1f80968b640a7` |
| Applied treasury policy            | `0ba6478fdb7651c557d052c0ee49a8d3ff302e826e277631b6a312ea` | unchanged **under that policy only**                       |

### A fresh settings deployment is mandatory

The settings UTxO is a one-shot NFT locked at the always-fails address with a
`ProtocolSettings` datum recording `group_policy` and the four treasury stake
hashes. **There is no update path** — no `UpdateSettings` redeemer exists in
`settings.ak` or the SDK. Because this wave changes the group and
treasury-rounds source, the existing datum can no longer describe the candidate
family, so the existing settings UTxO cannot authorize it.

A fresh settings seed produces a new `settingsPolicy`, and every ROSCA validator
is parameterized off it (`buildProtocol`):

```text
settingsPolicy → treasury (spend + mint) → treasuryPolicyId → group (spend + mint)
settingsPolicy → treasury_rounds / _lifecycle / _recovery / _reserve
```

So treasury, lifecycle, recovery and reserve get **new applied hashes even though
their source bytes are unchanged**. "Treasury unchanged" is true only against the
legacy deployment and must not be read as "no redeploy needed".

### What a 0.6.1 rollout actually requires

**Nine new reference scripts:**

| #   | Reference                                                                                         | Why it is new                                   |
| --- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1-6 | `treasury`, `group`, `treasuryRounds`, `treasuryLifecycle`, `treasuryRecovery`, `treasuryReserve` | reparameterized by the fresh settings policy    |
| 7   | `savings`                                                                                         | source changed (ADR-0002)                       |
| 8-9 | `governanceDispatcher`, `governanceVoting`                                                        | source changed, and instance-seed parameterized |

Plus, in order:

1. a fresh settings seed and settings UTxO (`initializeSettings`);
2. the six ROSCA reference scripts above;
3. **four fresh treasury stake registrations** (`registerTreasuryStake`), one per
   family — the withdraw-zero credentials must be registered on-chain before any
   treasury operation;
4. the savings reference script;
5. a **fresh governance instance** with its own seed, then its instance-specific
   reference scripts, `registerVotingStake`, voter registration, and a charter
   naming the new governed target.

**`escrowV2` carries over.** It is unparameterized and its source is unchanged,
so the existing reference at `fa2a6cb5…#0` stays valid.

**`pool` and `project` references are optional and excluded from the nine.**
Measured compiled sizes are 4,145 and 2,312 bytes, so both attach inline
comfortably within the 16,384-byte transaction limit. Deploy them as references
only if a specific flow needs the room.

### Legacy positions

The surviving legacy ROSCA groups (`8ada55c9…`, `29afcd9a…`, and
`277761570e…` in the 2026-08-05 inventory) remain governed by the old applied
hashes under settings policy `138efe0f…`. Their member/admin tokens are external,
so this wave does not attempt an unauthorized migration or wind-down. There is no
in-place upgrade: a position created under one settings policy cannot move to
another. Operationally:

- keep SDK `0.6.0-preprod.0` plus the existing Preprod manifest pinned for those
  positions;
- complete the full fresh-settings rollout above before creating any
  `0.6.1-preprod.0` group;
- never mix old group UTxOs/ref scripts with the candidate SDK, and never mix
  references across settings policies;
- update the canonical Preprod manifest only after exact-hash deployment and a
  create → join → start → default → terminate-next-slot → recommit → re-seal →
  distribute rehearsal succeeds on the new deployment.
