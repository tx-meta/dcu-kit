# @tx-meta/dcu-kit

[![npm](https://img.shields.io/npm/v/@tx-meta/dcu-kit)](https://www.npmjs.com/package/@tx-meta/dcu-kit)
[![CI](https://github.com/tx-meta/dcu-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tx-meta/dcu-kit/actions/workflows/ci.yml)

TypeScript offchain SDK for the **DCU Toolkit**, a ROSCA protocol on Cardano. Built on [Lucid Evolution](https://github.com/Anastasia-Labs/lucid-evolution) and [Effect](https://effect.website/).

## Installation

```sh
npm install @tx-meta/dcu-kit
# or
pnpm add @tx-meta/dcu-kit
```

## Usage

Every endpoint returns a `ProgramRunner` with three execution methods:

```ts
import { createAccount, CreateAccountConfig } from "@tx-meta/dcu-kit";

const config: CreateAccountConfig = {
  selected_out_ref: utxos[0],
  email: "user@example.com",
  phone: "555-0100",
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
| `nextCycle`      | Advance to next ROSCA cycle           |

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

| Function (v2)      | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `createEscrow`     | Lock funds against a deadline-bearing milestone schedule |
| `releaseMilestone` | Verifier approves the next tranche                     |
| `timeoutRelease`   | Crank an overdue tranche (auto-release escrows)        |
| `reclaimEscrow`    | Funder recovers an overdue escrow (refund escrows)     |
| `contribute`       | Fund-as-you-go top-up (`PerMilestone`)                 |
| `submitEvidence`   | Beneficiary anchors a deliverable hash                 |
| `rotateParty`      | A party replaces its own credential                    |
| `amendMilestones`  | Funder + beneficiary reshape unreleased milestones     |
| `raiseDispute`     | Freeze fund paths for the arbiter                      |
| `resolveDispute`   | Arbiter's terminal split between the parties           |
| `abortEscrow`      | Mutual-consent early exit                              |
| `createProject` / `updateProject` / `closeProject` | Project anchor lifecycle |
| `getEscrowState` / `getProjectState` / `getProjectEscrows` | Read-only queries |

Grace guidance: strict supplier delivery 3–7 days; professional services 14 days
(the default); construction and grant reporting 30 days. Grace covers coordination
lag — real project delays are handled by `amendMilestones`.

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

MIT
