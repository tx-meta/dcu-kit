# ADR-0003: Splitting the savings vault into two withdraw-zero families

Status: accepted, not yet implemented
Target release: `0.6.1-preprod.0` (unpublished; see "Release identity")

## Context

The savings vault compiles to 16,105 bytes against a 16,128-byte conservative
deployable-reference-script ceiling, leaving 23 bytes. It is effectively frozen:
any change, including a security fix, cannot be deployed without first making the
validator smaller. Doing that after an audit would block the fix behind a
refactor that itself changes the hash and needs its own rehearsal.

Savings is still experimental, has no live positions on the candidate hashes, and
nothing has been deployed. This is the cheapest moment the split will ever have.

The treasury precedent (spec 2026-07-04) established the pattern: a thin spending
validator plus withdraw-zero family stake validators carrying the heavy logic.

## Measurements

Probe validators containing subsets of the spend arms, each still carrying the
mint handlers and shared library. **These are probe estimates of a shape that is
not the final architecture**, used to rank options, not to predict final sizes.

Mint handlers plus shared library floor, measured alone: **4,450 bytes**.

| Candidate family          | compiled | % of 16,128 | marginal over floor |
| ------------------------- | -------: | ----------: | ------------------: |
| current single validator  |   16,105 |       99.9% |              11,655 |
| governed (6 quorum ops)   |   10,665 |       66.1% |               6,215 |
| direct (6 non-quorum ops) |   10,959 |       68.0% |               6,509 |
| _3-family_ member         |    8,830 |       54.7% |               4,380 |
| _3-family_ quorum         |    7,591 |       47.1% |               3,141 |
| _3-family_ loans          |   10,256 |       63.6% |               5,806 |

Per-operation solo probes ranged 4,898 (`RemoveAccount`) to 7,045 (`RepayLoan`).
No single handler dominates; the problem is accumulation.

## Decision

**Two families, split on authorization authority.**

`savings_governed`
: SocialPayout, UpdateFund, CloseCycle, CloseFund, DisburseLoan, WriteOffLoan

`savings_direct`
: Deposit, Withdraw, ClaimShareOut, RemoveAccount, RepayLoan, MarkArrears

"Direct" rather than "unguarded": these operations still enforce member,
borrower, timing and state authorization. The distinction is _who authorizes_,
not _how much is checked_.

### Why this boundary

1. **It is exactly the ADR-0002 boundary.** The governed six are precisely the
   intent-bound operations, so intent verification exists in one validator and
   ADR-0002 has a single enforcement path. A domain split (member / quorum /
   loans) scatters those six across two families and gives the intent logic two
   places to drift.
2. **One fewer permanent reference script**, reducing deployment cost and
   operational state. Reference scripts at the always-fails custody address are
   permanently unspendable, so each one is a standing cost.
3. **Headroom is close enough not to buy a third family.** 68.0% worst case
   versus 63.6%, both leaving over 5,000 bytes.
4. **The routing rule for future operations is unambiguous**: governance
   authorized goes to `savings_governed`, directly authorized goes to
   `savings_direct`.

### The intent invariant

ADR-0002's guarantee must survive the split unchanged. The governance gate reads
the commitment from `Spend(target)`'s redeemer at field 0. A field-less spending
redeemer, the literal treasury pattern, would silently void it for all six
governed operations.

Therefore:

- Every governed operation **preserves its constructor tag**.
- `intent_hash` **stays at field 0 of the spending redeemer**. It never moves to
  the withdrawal redeemer, and intent authority is never duplicated there.
- Only **indices and operational routing data** move to the family withdrawal.
- The **family withdrawal validator** must:
  1. cover the target savings input exactly once;
  2. read that input's spending redeemer;
  3. confirm the operation belongs to this family;
  4. recompute the economic intent from the validated transition;
  5. compare it against the spending redeemer's `intent_hash`.
- The **thin spending validator** must prove that the appropriate family
  withdrawal exists and covers its own input.

This keeps the governance gate independent of savings internals: it continues to
read field 0 of a spend redeemer and needs no knowledge of the family layout.

### Coverage invariant

Every savings input consumed by an operation must be covered exactly once by the
family withdrawal, anchor and satellite inputs included. Partial coverage,
duplicate coverage, foreign-input coverage and mixed-operation batching are all
rejected.

Mint and burn paths (loan mint and burn, account burn, fund burn) must prove that
the corresponding family transition occurred in the same transaction.

### Size budget

Each of the thin validator, `savings_governed` and `savings_direct` must
independently stay below:

- **80% of 16,128 bytes (12,902), the warning threshold**, enforced as a test;
- **16,128 bytes, the hard ceiling**, already enforced by `scriptSizes.test.ts`.

Crossing the warning threshold is the signal to split again, not to spend the
remaining headroom.

## Rejected alternatives

**Three families (member / quorum / loans).** Better worst-case headroom (63.6%),
but it splits the six intent-bound operations across `quorum` and `loans`,
duplicating intent recomputation into two validators. It also costs a fourth
permanent reference script. Headroom bought at the price of two enforcement
paths for ADR-0002 is a bad trade.

**Two families, member / everything-else.** Worst family 78.5%, too close to the
ceiling to be worth doing.

**Two families, member+quorum / loans.** Worst family 70.2%, and it still splits
the governed six.

**Leaving it at 16,105 bytes and splitting after the audit.** Any audit finding in
savings would be unfixable without this refactor first, and the refactor changes
the hash, invalidating the audited artifact.

## Negative-test matrix

Every row must fail. Aiken unit tests unless marked emulator.

### Family routing

| #   | Case                                                              |
| --- | ----------------------------------------------------------------- |
| R1  | governed operation presented with the `savings_direct` withdrawal |
| R2  | direct operation presented with the `savings_governed` withdrawal |
| R3  | no family withdrawal in the transaction at all                    |
| R4  | family withdrawal present but not covering this spending input    |
| R5  | withdrawal from a foreign script credential resembling a family   |
| R6  | withdrawal amount non-zero                                        |

### Coverage

| #   | Case                                                          |
| --- | ------------------------------------------------------------- |
| C1  | anchor input consumed but not covered                         |
| C2  | satellite (member / loan) input consumed but not covered      |
| C3  | the same input covered twice                                  |
| C4  | coverage naming an input the transaction does not consume     |
| C5  | coverage naming a foreign-script input                        |
| C6  | two different savings operations batched under one withdrawal |
| C7  | two withdrawals of the same family in one transaction         |

### Intent (governed family only)

| #   | Case                                                                                   |
| --- | -------------------------------------------------------------------------------------- |
| I1  | `intent_hash` correct for a different operation's payload                              |
| I2  | `intent_hash` of the right shape but wrong recipient                                   |
| I3  | wrong amount, principal, charge or due date                                            |
| I4  | wrong loan id                                                                          |
| I5  | correct parameters against a different fund                                            |
| I6  | empty or non-32-byte commitment                                                        |
| I7  | commitment present on the withdrawal redeemer instead of field 0 of the spend redeemer |
| I8  | constructor tag changed while the commitment is preserved                              |
| I9  | transaction input/output indices reordered, semantics unchanged: **must pass**         |
| I10 | governed operation whose transition output does not match the committed intent         |

### Mint and burn coupling

| #   | Case                                                   |
| --- | ------------------------------------------------------ |
| M1  | loan mint without the `DisburseLoan` family transition |
| M2  | loan burn without `RepayLoan` or `WriteOffLoan`        |
| M3  | account burn without `RemoveAccount`                   |
| M4  | fund burn without `CloseFund`                          |
| M5  | mint or burn attributed to the wrong family            |

### Regression (must pass)

| #   | Case                                                                  |
| --- | --------------------------------------------------------------------- |
| P1  | all twelve operations succeed on the happy path                       |
| P2  | all six golden intent vectors unchanged from ADR-0002                 |
| P3  | all six `*__rejects_wrong_intent` tests still fail correctly          |
| P4  | `update_fund__intent_survives_live_counter_changes` still passes      |
| P5  | emulator: full savings lifecycle including a governed loan end to end |
| P6  | emulator: cross-family transaction, loan origination and fund closure |

## Release identity

The split lands as **`0.6.1-preprod.0`**, reusing the version already in staging
rather than cutting `0.6.2`.

`0.6.1-preprod.0` has never been published. npm carries `0.6.0-preprod.0` on the
`preprod` tag and `0.4.1` on `latest`. VERSIONING rule 1 governs _a publish whose
fingerprints differ from the previous release_; since no 0.6.1 artifact exists for
any consumer, reusing the number creates no silent hash change.

**Consequence that must be handled:** staging's registry already carries a
`0.6.1-preprod.0` history entry recording the pre-split savings hash
`801774429f3dcf1b…`. When the split lands, that entry must be **amended in place**,
not appended to. Two entries claiming different savings hashes for one version
would make the history false.

## Gates before deployment

1. Two-family implementation complete, all three scripts under the 80% warning
   threshold, execution units measured.
2. Full negative-test matrix green, plus the complete emulator suite.
3. Registry `0.6.1-preprod.0` entry amended with the final hashes.
4. Fresh settings deployment, nine reference scripts, four stake registrations
   (ADR-0001).
5. Fresh governance instance and bootstrap.
6. Exact-hash Preprod verification.
7. Live ROSCA deadlock and recommit rehearsal (ADR-0001).

## Consumer impact

Positions cannot move across a settings policy or a hash change. An integrator
must route each position by **deployment identity**, not by globally swapping
configuration:

- existing `0.6.0-preprod.0` positions keep their settings policy, reference
  scripts and a compatible SDK;
- new positions use the deployed `0.6.1-preprod.0` family;
- the undeployed intermediate state is never used.

This requires version-aware manifests carrying both deployments rather than the
single current manifest.
