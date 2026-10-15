# DCU Toolkit: Decentralized Credit Unions Infrastructure

[![CI](https://github.com/tx-meta/dcu-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/tx-meta/dcu-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tx-meta/dcu-kit)](https://www.npmjs.com/package/@tx-meta/dcu-kit)

An open-source **developer toolkit** for building cooperative finance applications on Cardano. The DCU Toolkit provides the foundational infrastructure to digitize and automate community-based savings groups (Chamas, SACCOs, Tontines). It covers savings and lending, rotating savings (ROSCA), milestone escrow, and member governance. [Kyama](https://kyama.vercel.app) is a demo app built on the toolkit, running on Cardano Preprod.

## Architecture for Developers

The toolkit is organized into three interoperable layers:

### 1. Smart Contract Infrastructure ([onchain/](onchain/))
Four sibling Aiken projects, each with its own `aiken.toml` and compiled blueprint: [onchain/rosca/](onchain/rosca/) (group, treasury, account, settings), [onchain/escrow/](onchain/escrow/) (milestone escrow), [onchain/savings/](onchain/savings/) (savings and lending), and [onchain/governance/](onchain/governance/) (proposals and voting). Modular **Aiken** validators for:
- **Dynamic Group Formation**: Parameterizable group sizes, contribution schedules, and governance rules.
- **Automated ROSCA Rotation**: Trustless fund distribution and linear vesting logic.
- **CIP-68 Membership System**: Verifiable on-chain identity and reputation tracking.
- **Treasury Management**: Multi-sig fund control and automated dividend distribution.
- **Savings and Lending**: Share-based group funds, member loans with savings-linked borrowing limits, and a proportional share-out at the end of each cycle.
- **Member Governance**: Proposals and votes that can authorize fund operations, such as approving a loan.

### 2. Middleware & SDK ([sdk/](sdk/))
A **TypeScript/Effect** library designed to streamline dApp development:
- **Transaction Construction**: High-level builders for complex cooperative finance flows.
- **Wallet Integration**: Unified interface for connecting Cardano wallets.
- **On-Chain Interaction**: Type-safe helpers for interacting with DCU validators.

### 3. Reference Implementation ([sdk/examples/](sdk/examples/))
Standalone scripts and demonstration code showing how to bundle the on-chain and off-chain layers into a functional application.

## Quick Start

```sh
npm install @tx-meta/dcu-kit
```

Refer to the [SDK README](sdk/README.md) for the full integration guide and API overview.

## CI Pipeline

| Job | What it checks |
|---|---|
| 🔧 Verify SDK | Format, lint, type check, build, tests (Lucid emulator) |
| 🛡️ Verify Aiken | Format check, build, on-chain unit tests (rosca, escrow, savings, governance) |
| 📄 Verify Design Specs | Typst compilation of protocol spec |

All three jobs must pass before a PR can merge. The publish workflow fires automatically when a GitHub Release is created.

## Contributing

```sh
# From sdk/
pnpm install
pnpm format:check   # Prettier
pnpm lint           # ESLint
pnpm tsc --noEmit   # Type check
pnpm run build      # Compile to dist/
NETWORK=Emulator pnpm test  # Run full test suite against Lucid emulator
```

Aiken on-chain checks:
```sh
# From each of onchain/rosca/, onchain/escrow/, onchain/savings/ and onchain/governance/
aiken fmt --check
aiken build
aiken check
```

## License

DCU Toolkit is licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2026 Tx Meta.

Versions published before the switch to Apache-2.0 (up to and including `0.6.2-preprod.0`) remain
under the Business Source License 1.1 they were released with.
