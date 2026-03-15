# DCU Off-Chain SDK

A TypeScript middleware layer for interacting with the **Decentralized Credit Union** smart contracts.

## Developer Features

- **Effect-Powered**: Built on the [Effect](https://effect.website/) ecosystem for robust, type-safe error handling and concurrency.
- **Transaction Builders**: Abstracted logic for complex multi-validator transactions (Account, Group, and Treasury).

## Integration Guide

1. **Setup Environment**:
```sh
pnpm install
```

3. Build the SDK:
```sh
pnpm run build
```

4. Bundle the package:
```sh
pnpm repack
```

5. In your project's `package.json`, add as a dependency:
```json
{
  "dependencies": {
    "@dcu/sdk": "file:../sdk/dcu-sdk-0.1.0.tgz"
  }
}
```

## API Overview

The SDK exposes `unsigned...Program` functions that return `Effect` blueprints yielding a `Lucid` `TxSignBuilder`.

### Core Endpoints
- **Account Actions**: `Create`, `Update`, `Delete` (CIP-68).
- **Group Management**: `Create`, `Join`, `Exit`, `Update`, `Delete`.
- **Financial Operations**: `DistributePayout`, `MemberWithdraw`, `TerminateGroup`.

For the underlying validator logic, see the [Design Specifications](../docs/dcu-kit-design-specs/dcu-kit.pdf).
