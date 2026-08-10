# ADR-0003: Splitting the savings vault into two withdraw-zero families

Status: accepted, implemented (2026-08-10)
Target release: `0.6.2-preprod.0` (see "Release identity")

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

### Measured against the implemented shape (2026-08-10)

The probes above still carried the mint handlers and no family withdrawal. The
implemented architecture puts the mint handlers in the thin dispatcher and
nothing else, so both families came in well below their probe estimates:

| Compiled validator | bytes | % of 16,128 |
| ------------------ | ----: | ----------: |
| `savings_vault` (thin dispatcher, mint + spend) | 4,731 | 29.3% |
| `savings_governed` | 8,713 | 54.0% |
| `savings_direct` | 8,873 | 55.0% |

All three are under the 12,902-byte warning threshold, enforced by
`sdk/test/scriptSizes.test.ts`.

Transaction size and execution units, measured on the Lucid emulator with real
UPLC evaluation across all twelve operations
(`sdk/test/savings.test.ts`, "ADR-0003 gate 1"):

| Operation | script execs | tx bytes | % tx limit | % max mem | % max steps |
| --------- | -----------: | -------: | ---------: | --------: | ----------: |
| `RepayLoan` (closing) | 5 |  9,999 | 61.0% | 8.2% | 4.2% |
| `RepayLoan` (partial) | 4 | 10,144 | 61.9% | 8.1% | 4.1% |
| `WriteOffLoan`        | 5 |  9,844 | 60.1% | 8.0% | 4.2% |
| `DisburseLoan`        | 4 | 10,123 | 61.8% | 7.5% | 4.0% |
| `Deposit`             | 3 |  9,823 | 60.0% | 5.8% | 2.9% |
| `MarkArrears`         | 2 |  9,525 | 58.1% | 2.4% | 1.2% |

The size column is the inline-family worst case: those transactions reference
the dispatcher but attach the family validator inline, which is permitted only
on the emulator. A live deployment references both, so roughly 8.8 KB comes off
every figure. Execution units are unaffected by where the script bytes come
from. The binding constraint is now execution units at well under a tenth of
the per-transaction budget, not size.

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
- The **thin spending validator** must bind EVERY vault input it guards — anchor
  and satellites alike — to both the family its constructor names AND that
  family's action variant, and must prove that action covers the input.
  Coverage alone is not enough: without the action-tag half, a satellite could
  be spent under any other constructor of the same family while the anchor's
  transition still validated, so the redeemer sitting on that input would not
  describe the operation that ran. That redeemer is the ABI the Gate reads.

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
| R7  | satellite spent with another constructor of the SAME family       |
| R8  | satellite spent with a governed constructor under a direct action |
| R9  | governed satellite spent with another governed constructor        |

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

The split lands as **`0.6.2-preprod.0`**, appended to the registry history.

An earlier draft of this ADR proposed reusing `0.6.1-preprod.0` on the grounds
that it was never published, so no consumer could observe the change. That was
rejected: `0.6.1-preprod.0` already has a release commit and a registry identity
on staging, and rewriting a version's recorded fingerprints in place weakens
reproducibility whether or not anyone downloaded the artifact. A version's
history entry describes what that version was, not what we later wished it had
been.

So:

- `0.6.1-preprod.0` stands as the **undeployed pre-split candidate**, with its
  original savings fingerprint `801774429f3dcf1b…` intact in the history.
- `0.6.2-preprod.0` carries the split, **appended** as a new history entry.
- Neither is deployed. Consumers stay on `0.6.0-preprod.0`, which is what the
  Preprod manifest still describes.

## Gates before deployment

1. ~~Two-family implementation complete, all three scripts under the 80% warning
   threshold, execution units measured.~~ Done 2026-08-10; see "Measured against
   the implemented shape".
2. ~~Full negative-test matrix green, plus the complete emulator suite.~~ Done
   2026-08-10: 51 matrix checks in `onchain/savings/validators/split-tests.ak`,
   778 Aiken checks and the full SDK suite green.
3. ~~Registry history entry recorded for `0.6.2-preprod.0`.~~ Done 2026-08-10,
   appended; `0.6.1-preprod.0` keeps its own entry unchanged.
4. Fresh settings deployment, **eleven** reference scripts, **six** stake
   registrations (four treasury, two savings) — ADR-0001 plus this ADR.
5. Fresh governance instance and bootstrap.
6. Exact-hash Preprod verification.
7. Live ROSCA deadlock and recommit rehearsal (ADR-0001).

## Consumer impact

Positions cannot move across a settings policy or a hash change. An integrator
must route each position by **deployment identity**, not by globally swapping
configuration:

- existing `0.6.0-preprod.0` positions keep their settings policy, reference
  scripts and a compatible SDK;
- new positions use the deployed `0.6.2-preprod.0` family;
- the undeployed intermediate state is never used.

This requires version-aware manifests carrying both deployments rather than the
single current manifest.
