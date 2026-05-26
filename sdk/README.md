# @tx-meta/dcu-sdk

[![npm](https://img.shields.io/npm/v/@tx-meta/dcu-sdk)](https://www.npmjs.com/package/@tx-meta/dcu-sdk)
[![CI](https://github.com/tx-meta/dcu-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/tx-meta/dcu-kit/actions/workflows/ci.yml)

TypeScript offchain SDK for the **DCU Toolkit** — a ROSCA protocol on Cardano. Built on [Lucid Evolution](https://github.com/Anastasia-Labs/lucid-evolution) and [Effect](https://effect.website/).

## Installation

```sh
npm install @tx-meta/dcu-sdk
# or
pnpm add @tx-meta/dcu-sdk
```

## Usage

Every endpoint returns a `makeReturn` object with three methods:

```ts
import { unsignedCreateAccountProgram } from "@tx-meta/dcu-sdk";

const result = unsignedCreateAccountProgram(lucid, config);

// Unsafe — throws on failure
const tx = await result.unsafeRun();

// Safe — returns Either
const tx = await result.safeRun();

// Effect — for composition
const tx = result.program();
```

## API Overview

### Account Endpoints

| Function                       | Description                  |
| ------------------------------ | ---------------------------- |
| `unsignedCreateAccountProgram` | Mint CIP-68 membership token |
| `unsignedUpdateAccountProgram` | Update account metadata      |
| `unsignedDeleteAccountProgram` | Burn membership token        |

### Group Endpoints

| Function                        | Description                           |
| ------------------------------- | ------------------------------------- |
| `unsignedCreateGroupProgram`    | Create a new ROSCA group              |
| `unsignedJoinGroupProgram`      | Join a group, lock treasury deposit   |
| `unsignedStartGroupProgram`     | Activate group, set rotation schedule |
| `unsignedExitGroupProgram`      | Exit before or after maturity         |
| `unsignedUpdateGroupProgram`    | Update group parameters               |
| `unsignedDeleteGroupProgram`    | Delete an unstarted group             |
| `unsignedTerminateGroupProgram` | Admin: terminate with penalty         |
| `unsignedNextCycleProgram`      | Advance to next ROSCA cycle           |

### Treasury Endpoints

| Function                                | Description                       |
| --------------------------------------- | --------------------------------- |
| `unsignedDistributeRoundProgram`        | Pay out current round's borrower  |
| `unsignedContributeProgram`             | Top up treasury balance           |
| `unsignedDeferRoundProgram`             | Mark member as deferred for round |
| `unsignedUpdatePayoutCredentialProgram` | Update payout destination         |
| `unsignedExtendGraceWindowProgram`      | Admin: extend grace period        |

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

Tests use `vitest` + `@effect/vitest` against the Lucid emulator (real UPLC execution — no mocks):

```sh
NETWORK=Custom pnpm test                        # All suites
NETWORK=Custom pnpm test test/account.test.ts   # Account only
NETWORK=Custom pnpm test test/group.test.ts     # Group only
NETWORK=Custom pnpm test test/treasury.test.ts  # Treasury only
NETWORK=Custom pnpm test -- -t "pattern"        # Filter by name
```

`NETWORK=Custom` is required — without it the SDK attempts to connect to Preprod.

## Publishing

The SDK is published automatically via GitHub Actions when a GitHub Release is created:

1. Merge your changes to `main`
2. All CI checks must pass
3. Create a GitHub Release tagged `vX.Y.Z`
4. The [publish workflow](../.github/workflows/publish.yml) builds and publishes to npm with provenance attestation

Manual publish (emergency): trigger `workflow_dispatch` from the Actions tab.

The `NPM_TOKEN` secret must be set in the repository settings (Automation token with read/write package access).

## License

MIT
