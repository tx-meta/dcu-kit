# DCU Toolkit Examples

Standalone scripts demonstrating SDK usage.

## How to Run

1. **Prepare the SDK**:
```bash
cd ../sdk
pnpm install
pnpm run build
pnpm run repack
```

2. **Setup Examples**:
```bash
cd ../examples
rm -rf node_modules dist
pnpm add ../sdk/dcu-sdk-0.1.0.tgz
pnpm install
```

3. **Run Example**:
```bash
# Using tsx
npx tsx create-account.ts

# Or via build
pnpm run build && pnpm run start
```
