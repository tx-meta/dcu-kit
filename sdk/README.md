# @tx-meta/dcu-sdk

[![npm](https://img.shields.io/npm/v/@tx-meta/dcu-sdk)](https://www.npmjs.com/package/@tx-meta/dcu-sdk)
[![CI](https://github.com/tx-meta/dcu-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/tx-meta/dcu-kit/actions/workflows/ci.yml)

TypeScript offchain SDK for the **DCU Toolkit**, a ROSCA protocol on Cardano. Built on [Lucid Evolution](https://github.com/Anastasia-Labs/lucid-evolution) and [Effect](https://effect.website/).

## Installation

```sh
npm install @tx-meta/dcu-sdk
# or
pnpm add @tx-meta/dcu-sdk
```

## Usage

Every endpoint returns a `ProgramRunner` with three execution methods:

```ts
import { createAccount, CreateAccountConfig } from "@tx-meta/dcu-sdk";

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

| Function                 | Description                       |
| ------------------------ | --------------------------------- |
| `distributePayout`       | Pay out current round's borrower  |
| `contribute`             | Top up treasury balance           |
| `deferRound`             | Mark member as deferred for round |
| `updatePayoutCredential` | Update payout destination         |
| `extendGraceWindow`      | Admin: extend grace period        |

### Admin

| Function           | Description                            |
| ------------------ | -------------------------------------- |
| `deployScripts`    | Deploy validators as reference scripts |
| `verifyDeployment` | Verify reference script UTxOs          |

## Development

```sh
pnpm install
pnpm format:check   # Prettier check
pnpm format         # Auto-fix formatting
pnpm lint           # ESLint
pnpm tsc --noEmit   # Type check
pnpm run build      # Compile to dist/
NETWORK=Custom pnpm test  # Full test suite (Lucid emulator, no live network)
```

## Testing

Tests use `vitest` + `@effect/vitest` against the Lucid emulator (real UPLC execution, no mocks):

```sh
NETWORK=Custom pnpm test                        # All suites
NETWORK=Custom pnpm test test/account.test.ts   # Account only
NETWORK=Custom pnpm test test/group.test.ts     # Group only
NETWORK=Custom pnpm test test/treasury.test.ts  # Treasury only
NETWORK=Custom pnpm test -- -t "pattern"        # Filter by name
```

`NETWORK=Custom` is required. Without it the SDK attempts to connect to Preprod.

## License

MIT
