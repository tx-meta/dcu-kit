# @tx-meta/dcu-kit

[![npm](https://img.shields.io/npm/v/@tx-meta/dcu-kit)](https://www.npmjs.com/package/@tx-meta/dcu-kit)
[![CI](https://github.com/tx-meta/dcu-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tx-meta/dcu-kit/actions/workflows/ci.yml)

TypeScript offchain SDK for the **DCU Toolkit**, cooperative finance on Cardano: savings and lending, rotating savings (ROSCA), escrow, and governance. Built on [Lucid Evolution](https://github.com/Anastasia-Labs/lucid-evolution) and [Effect](https://effect.website/).

## Installation

```sh
npm install @tx-meta/dcu-kit
# or
pnpm add @tx-meta/dcu-kit
```

## Usage

Every endpoint returns a `ProgramRunner` with three execution methods:

```ts
import {
  computeProfileCommitment,
  createAccount,
  CreateAccountConfig,
} from "@tx-meta/dcu-kit";

const config: CreateAccountConfig = {
  selected_out_ref: utxos[0],
  // Optional: keep the profile and salt off-chain.
  profileCommitment: computeProfileCommitment(
    JSON.stringify({ name: "@alice" }),
    saltHex,
  ),
};

// Unsafe: throws on failure
const tx = await createAccount(lucid, config).unsafeRun();

// Safe: returns Either (no throw)
const tx = await createAccount(lucid, config).safeRun();

// Effect: for composition with other Effects
const tx = createAccount(lucid, config).program();
```

Sign and submit after building:

```ts
const signed = await tx.sign.withWallet().complete();
const txHash = await signed.submit();
```

## API Overview

### Account Endpoints

| Function        | Description                  |
| --------------- | ---------------------------- |
| `createAccount` | Mint CIP-68 membership token |
| `updateAccount` | Update account metadata      |
| `deleteAccount` | Burn membership token        |

### Group Endpoints

| Function         | Description                           |
| ---------------- | ------------------------------------- |
| `createGroup`    | Create a new ROSCA group              |
| `joinGroup`      | Join a group, lock treasury deposit   |
| `startGroup`     | Activate group, set rotation schedule |
| `exitGroup`      | Exit before or after maturity         |
| `updateGroup`    | Update group parameters               |
| `deleteGroup`    | Delete an unstarted group             |
| `terminateGroup` | Admin: terminate with penalty         |

### Treasury Endpoints

| Function                 | Description                      |
| ------------------------ | -------------------------------- |
| `distributePayout`       | Pay out current round's borrower |
| `contribute`             | Top up treasury balance          |
| `updatePayoutCredential` | Update payout destination        |
| `extendGraceWindow`      | Admin: extend grace period       |

### Admin

| Function           | Description                            |
| ------------------ | -------------------------------------- |
| `deployScripts`    | Deploy validators as reference scripts |
| `verifyDeployment` | Verify reference script UTxOs          |

### Escrow (`@tx-meta/dcu-kit/escrow` — v1, and `@tx-meta/dcu-kit/escrow/v2`)

Validators are versioned, never replaced: v1 keeps serving existing escrows on its
original hash; v2 is a new validator generation for new contracts.

v2 adds per-milestone deadlines with a grace (cure) window, `Upfront` and
`PerMilestone` funding (`contribute` tops up), a timeout policy (`RefundToFunder`
reclaim, or `ReleaseToBeneficiary` auto-release — "silence approves"), deliverable
evidence hashes, party rotation (wallet migration / verifier handoff / assigning the
receivable), consensual milestone amendment, an optional arbiter with dispute
freeze + terminal split, and a Project anchor that groups escrows
(`getProjectEscrows` = the funding dashboard).

All parties are passed as plain bech32 addresses (script callers may pass
`{ type, hash }`); no UI should ever ask a person for a credential or key.

| Function (v2)                                              | Description                                              |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `createEscrow`                                             | Lock funds against a deadline-bearing milestone schedule |
| `releaseMilestone`                                         | Verifier approves the next tranche                       |
| `timeoutRelease`                                           | Crank an overdue tranche (auto-release escrows)          |
| `reclaimEscrow`                                            | Funder recovers an overdue escrow (refund escrows)       |
| `contribute`                                               | Fund-as-you-go top-up (`PerMilestone`)                   |
| `submitEvidence`                                           | Beneficiary anchors a deliverable hash                   |
| `rotateParty`                                              | A party replaces its own credential                      |
| `amendMilestones`                                          | Funder + beneficiary reshape unreleased milestones       |
| `raiseDispute`                                             | Freeze fund paths for the arbiter                        |
| `resolveDispute`                                           | Arbiter's terminal split between the parties             |
| `abortEscrow`                                              | Mutual-consent early exit                                |
| `createProject` / `updateProject` / `closeProject`         | Project anchor lifecycle                                 |
| `getEscrowState` / `getProjectState` / `getProjectEscrows` | Read-only queries                                        |

Grace guidance: strict supplier delivery 3–7 days; professional services 14 days
(the default); construction and grant reporting 30 days. Grace covers coordination
lag — real project delays are handled by `amendMilestones`.

### Savings and lending (`@tx-meta/dcu-kit/savings`)

A savings fund is a group pool in any Cardano asset. Members buy shares with each
deposit, borrow with the group's approval, and claim a proportional share-out when
the cycle closes. A fund's charter sets whether savings are locked until share-out
or flexible, and the borrowing limit as a multiple of the borrower's savings
(`maxLoanMultiple`, default 1). A flexible withdrawal needs an active fund, enough
funds in the pool, and enough remaining shares to cover the member's open loan.
At the default limit a loan never exceeds the borrower's savings. Above it, a
write-off recovers what the borrower's shares cover, and the rest reduces the pot
that every member shares.

| Function               | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `registerSavingsStake` | Register the savings stake credentials, once per deployment    |
| `createFund`           | Open a fund and set its charter                                |
| `joinFund`             | Join a fund and mint the member's account token                |
| `deposit`              | Buy shares or pay into the social fund                         |
| `withdrawSavings`      | Sell shares back before the cycle closes (flexible funds only) |
| `socialPayout`         | Quorum: pay a welfare claim from the social fund               |
| `updateFund`           | Quorum: amend the charter's mutable fields                     |
| `disburseLoan`         | Quorum and borrower: pay a loan out of the pool                |
| `repayLoan`            | Repay part or all of a loan, plus its service charge           |
| `markArrears`          | Move an overdue loan to `Late`, then `Defaulted` (anyone)      |
| `writeOffLoan`         | Quorum: close a `Defaulted` loan against the borrower's shares |
| `closeCycle`           | Quorum: freeze the share-out snapshot                          |
| `claimShareOut`        | Claim the member's proportional share of the pot               |
| `exitFund`             | Leave the fund once the member holds no shares                 |
| `closeFund`            | Quorum: close the fund after every share is claimed            |

### Governance (`@tx-meta/dcu-kit/governance`)

Members propose, vote (optionally weighted by savings shares), and execute decisions. A
savings fund can name a governance instance as its quorum, so loans and payouts
pass by member vote.

| Function              | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `initGovernance`      | Create a governance instance                                 |
| `registerVotingStake` | Register the instance's voting stake credential, once        |
| `registerVoter`       | Register a member as a voter                                 |
| `splitEligibility`    | Split eligibility tokens into separate outputs before a vote |
| `openProposal`        | Open a proposal                                              |
| `castVote`            | Cast one weighted vote                                       |
| `finalizeProposal`    | Tally a proposal after its deadline                          |
| `executeDecision`     | Execute a passed proposal                                    |
| `authorizeAction`     | Spend a decision to authorize the operation it approved      |
| `expireProposal`      | Retire a failed proposal, or a passed one never executed     |
| `updateCharter`       | Amend the instance's mutable charter fields                  |

## Development

```sh
pnpm install
pnpm format:check   # Prettier check
pnpm format         # Auto-fix formatting
pnpm lint           # ESLint
pnpm tsc --noEmit   # Type check
pnpm run build      # Compile to dist/
NETWORK=Emulator pnpm test  # Full test suite (Lucid emulator, no live network)
```

## Testing

Tests use `vitest` + `@effect/vitest` against the Lucid emulator (real UPLC execution, no mocks):

```sh
NETWORK=Emulator pnpm test                        # All suites
NETWORK=Emulator pnpm test test/account.test.ts   # Account only
NETWORK=Emulator pnpm test test/group.test.ts     # Group only
NETWORK=Emulator pnpm test test/treasury.test.ts  # Treasury only
NETWORK=Emulator pnpm test -- -t "pattern"        # Filter by name
```

`NETWORK=Emulator` is required. Without it the SDK attempts to connect to Preprod.

## License

Apache License, Version 2.0. See the repository's
[LICENSE](https://github.com/tx-meta/dcu-kit/blob/main/LICENSE). Versions up to
and including `0.6.2-preprod.0` were released under the Business Source License 1.1.
