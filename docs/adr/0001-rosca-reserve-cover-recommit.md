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

| N=20 distribution | Memory | CPU | Serialized size |
|---|---:|---:|---:|
| Dry mandatory reserve | 10,489,102 (63.6%) | 3,241,829,376 (32.4%) | 7,287 B (44.5%) |
| Levy + active stand-in | 10,531,168 (63.8%) | 3,256,507,411 (32.6%) | — |

The active-stand-in probe is below all abort thresholds, so the
`cover_pending` Plan B is not activated. The size measurement uses the complete
N=20 dry-reserve SDK transaction with reference scripts; execution-unit figures
use the real withdraw validator through the Aiken scale harness.

## Hash and Preprod migration record

SDK `0.6.1-preprod.0` contains the candidate family:

| Component | Existing Preprod | Wave-1 candidate |
|---|---|---|
| Applied group policy | `3cfdf8bf653ca8be1af605e4df4f00433f704ab0172e420b54209416` | `9f3cf4e446fe912fe57750a91612d1017e7de33cf6eb35e3fc4090d8` |
| Applied treasury-rounds stake hash | `4689e405085170a8cf03ac1b6bb88bf1a3c048bed603e5564f344d15` | `7f37fc638b12e1ad429c65f0a7d177f9c77edad912a1f80968b640a7` |
| Applied treasury policy | `0ba6478fdb7651c557d052c0ee49a8d3ff302e826e277631b6a312ea` | unchanged |

The surviving legacy ROSCA groups (`8ada55c9…`, `29afcd9a…`, and
`277761570e…` in the 2026-08-05 inventory) remain governed by the old applied
hashes. Their member/admin tokens are external, so this wave does not attempt an
unauthorized migration or wind-down. Operationally:

- keep SDK `0.6.0-preprod.0` plus the existing Preprod manifest pinned for those
  positions;
- deploy new group and treasury-rounds reference scripts before creating any
  `0.6.1-preprod.0` group;
- never mix old group UTxOs/ref scripts with the candidate SDK;
- update the canonical Preprod manifest only after exact-hash deployment and a
  create → join → start → default → terminate-next-slot → recommit → re-seal →
  distribute rehearsal succeeds.
