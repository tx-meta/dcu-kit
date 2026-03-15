# DCU Toolkit: Decentralized Credit Unions Infrastructure

An open-source **developer toolkit** for building cooperative finance applications on Cardano. The DCU Toolkit provides the foundational infrastructure to digitize and automate community-based savings groups (Chamas, SACCOs, Tontines).

## Architecture for Developers

The toolkit is organized into three interoperable layers:

### 1. Smart Contract Infrastructure ([onchain/](onchain/))
Modular **Aiken** validators for:
- **Dynamic Group Formation**: Parameterizable group sizes, contribution schedules, and governance rules.
- **Automated ROSCA Rotation**: Trustless fund distribution and linear vesting logic.
- **CIP-68 Membership System**: Verifiable on-chain identity and reputation tracking.
- **Treasury Management**: Multi-sig fund control and automated dividend distribution.

### 2. Middleware & SDK ([sdk/](sdk/))
A **TypeScript/Effect** library designed to streamline dApp development:
- **Transaction Construction**: High-level builders for complex cooperative finance flows.
- **Wallet Integration**: Unified interface for connecting Cardano wallets.
- **On-Chain Interaction**: Type-safe helpers for interacting with DCU validators.

### 3. Reference Implementation ([examples/](examples/))
Standalone scripts and demonstration code showing how to bundle the on-chain and off-chain layers into a functional application.

## Quick Start

Refer to the [Examples README](examples/README.md) to build the SDK and run your first interaction script.
