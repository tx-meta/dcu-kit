# DCU Toolkit SDK — Patterns Reference

This file is the **authoritative source** for all SDK conventions. Skills, docs, and code reviews
should reference this file rather than duplicating patterns inline. When a convention changes,
update this file as part of the same PR — skills inherit the change automatically.

---

## File layout (every endpoint project follows this)

```
sdk/src/
├── index.ts                          # barrel — re-exports endpoints + core
├── endpoints/
│   ├── <operationName>.ts            # one file per operation
│   ├── programWrapper.ts             # makeReturn()-wrapped public API
│   └── index.ts                      # re-exports all wrappers
├── multisig/                         # standalone module — "@tx-meta/dcu-kit/multisig"
│   ├── build.ts                      # buildMultisig (native atLeast M-of-N)
│   ├── adminWitness.ts               # AdminAuthConfig, payAdminReturn, applyAdminWitness
│   └── index.ts
└── core/
    ├── errors.ts                     # error taxonomy — create first
    ├── types.ts                      # datum + redeemer schemas
    ├── treasury.utils.ts             # domain-specific helpers (if needed)
    ├── plutus.json                   # compiled Aiken blueprint
    └── validators/
        ├── context.ts                # makeValidators() factory
        ├── constants.ts              # validator registry + policy IDs
        └── reader.ts                 # blueprint parser
    └── utils/
        ├── wallet.ts                 # getWalletAddress, getWalletUtxos, getUtxosAt
        ├── tx.ts                     # makeReturn, ProgramRunner, signAndSubmit, waitForTx
        ├── script.ts                 # getScriptAddress
        ├── assets.ts                 # createCip68TokenNames, findCip68TokenPair
        └── utils.ts                  # parseSafeDatum
```

**Module boundaries (enforced by review):** `core/` and `multisig/` NEVER import from
`endpoints/`. Layering is `core` ← `multisig` ← `endpoints`. `multisig` and `core` are published
as subpath exports (`@tx-meta/dcu-kit/multisig`, `@tx-meta/dcu-kit/core`) so other apps consume
them without the ROSCA endpoints; keeping the boundary clean is what makes the future package
split (coop-core / coop-multisig / coop-escrow / dcu-kit) mechanical.
Check: `grep -rn "from \"../endpoints" src/core src/multisig` must return nothing.

**Build order when starting a new project:**

1. `core/errors.ts` — everything else imports from here
2. `core/types.ts` — datum + redeemer schemas
3. `core/validators/constants.ts` — load blueprint, derive policy IDs
4. Endpoints one at a time, each with its test before the next

---

## Error taxonomy (`src/core/errors.ts`)

12 `Data.TaggedError` types — copy this exactly, rename the union type to match the project:

```typescript
import { Data } from "effect";

// --- Base ---
export class LucidError extends Data.TaggedError("LucidError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// --- UTxO ---
export class UtxoNotFoundError extends Data.TaggedError("UtxoNotFound")<{
  readonly tokenName: string;
  readonly address: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class InsufficientUtxosError extends Data.TaggedError(
  "InsufficientUtxos",
)<{
  readonly required: number;
  readonly available: number;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

// --- Datum ---
export class InvalidDatumError extends Data.TaggedError("InvalidDatum")<{
  readonly field: string;
  readonly reason: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class DatumDecodingError extends Data.TaggedError("DatumDecodingError")<{
  readonly utxoId: string;
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

// --- Transaction ---
export class TransactionBuildError extends Data.TaggedError(
  "TransactionBuildError",
)<{
  readonly operation: string;
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class TransactionSignError extends Data.TaggedError(
  "TransactionSignError",
)<{
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class TransactionSubmitError extends Data.TaggedError(
  "TransactionSubmitError",
)<{
  readonly txHash?: string;
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

// --- Validator ---
export class ValidatorNotFoundError extends Data.TaggedError(
  "ValidatorNotFound",
)<{
  readonly validatorName: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class BlueprintLoadError extends Data.TaggedError("BlueprintLoadError")<{
  readonly path: string;
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly configKey: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class SetupError extends Data.TaggedError("SetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// --- Union ---
export type DcuError =
  | LucidError
  | UtxoNotFoundError
  | InsufficientUtxosError
  | InvalidDatumError
  | DatumDecodingError
  | TransactionBuildError
  | TransactionSignError
  | TransactionSubmitError
  | ValidatorNotFoundError
  | BlueprintLoadError
  | ConfigurationError
  | SetupError;
```

---

## Datum + redeemer types (`src/core/types.ts`)

Triple-declaration pattern — all three lines required:

```typescript
import { Data } from "@lucid-evolution/lucid";

export const GroupDatumSchema = Data.Object({
  contribution_fee: Data.Integer(),
  num_intervals: Data.Integer(),
  interval_length: Data.Integer(),
  member_count: Data.Integer(),
  start_time: Data.Integer(),
  is_active: Data.Boolean(),
  admin_pkh: Data.Bytes(),
});
export type GroupDatum = Data.Static<typeof GroupDatumSchema>;
export const GroupDatum = GroupDatumSchema as unknown as GroupDatum;

// Redeemer — discriminated enum
export const GroupRedeemerSchema = Data.Enum([
  Data.Object({
    CreateGroup: Data.Object({
      input_index: Data.Integer(),
      output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    UpdateGroup: Data.Object({
      group_input_index: Data.Integer(),
      admin_input_index: Data.Integer(),
    }),
  }),
  Data.Object({
    DeleteGroup: Data.Object({
      group_input_index: Data.Integer(),
      admin_input_index: Data.Integer(),
    }),
  }),
]);
export type GroupRedeemer = Data.Static<typeof GroupRedeemerSchema>;
export const GroupRedeemer = GroupRedeemerSchema as unknown as GroupRedeemer;
```

Rules:

- Field names must match Aiken source **exactly** (snake_case)
- Use `Data.Integer()` for all numeric fields (maps to Aiken `Int`)
- Use `Data.Bytes()` for hashes, addresses, token names
- Use `Data.Boolean()` for flags
- For enums with no fields use `Data.Literal("VariantName")`

---

## Endpoint skeleton

Every endpoint follows this exact shape — no deviations:

````typescript
import {
  LucidEvolution,
  Data,
  UTxO,
  TxSignBuilder,
  RedeemerBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { MyDatum, MyRedeemer } from "../core/types.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import {
  getWalletAddress,
  getScriptAddress,
  parseSafeDatum,
} from "../core/utils/index.js";
import { myValidator, myPolicyId } from "../core/validators/constants.js";

/**
 * Creates an unsigned transaction for [operation].
 *
 * **Functionality:**
 * - [bullet 1]
 * - [bullet 2]
 *
 * @param lucid  - Lucid instance with wallet selected.
 * @param config - [OperationName]Config.
 * @returns Effect yielding TxSignBuilder.
 *
 * @example
 * ```typescript
 * const tx = await myOperation(lucid, config).unsafeRun();
 * ```
 */
export type MyOperationConfig = {
  utxo: UTxO;
  datum: MyDatum;
};

export const unsignedMyOperationTxProgram = (
  lucid: LucidEvolution,
  config: MyOperationConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    // 1. Hoist addresses — never inline lucid.wallet().address()
    const address = yield* getWalletAddress(lucid);
    const scriptAddress = yield* getScriptAddress(lucid, myValidator.spend);

    // 2. Parse existing datum if consuming a script UTxO
    const currentDatum = yield* parseSafeDatum(config.utxo.datum, MyDatum);

    // 3. Build redeemer — use RedeemerBuilder when redeemer references input indices
    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            MyVariant: { input_index: inputIndices[0] },
          },
          MyRedeemer,
        ),
      inputs: [config.utxo],
    };

    // 4. Build and complete — completeProgram() not .complete()
    return yield* lucid
      .newTx()
      .collectFrom([config.utxo], redeemer)
      .attach.SpendingValidator(myValidator.spend)
      .pay.ToContract(
        scriptAddress,
        { kind: "inline", value: Data.to(updatedDatum, MyDatum) },
        config.utxo.assets,
      )
      .addSigner(address)
      .completeProgram() // NOT .complete()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "myOperation",
              error: String(e),
            }),
        ),
      );
  });
````

---

## programWrapper.ts

Every exported endpoint is wrapped with `makeReturn()`:

```typescript
import { makeReturn } from "../core/utils/index.js";
import {
  unsignedMyOperationTxProgram,
  MyOperationConfig,
} from "./myOperation.js";

export const myOperation = (lucid: LucidEvolution, config: MyOperationConfig) =>
  makeReturn(unsignedMyOperationTxProgram(lucid, config));
```

Consumer API (all three available on every endpoint):

```typescript
// Throws on error — use in scripts and examples
const tx = await myOperation(lucid, config).unsafeRun();

// Returns Either — use in application code
const result = await myOperation(lucid, config).safeRun();
if (Either.isLeft(result)) {
  /* handle error */
}

// Returns Effect — use inside Effect.gen()
const tx = yield * myOperation(lucid, config).program();
```

---

## Core utilities

### `parseSafeDatum(datum, Schema)` — always use over `Data.from(datum!)`

```typescript
// ✅
const myDatum = yield * parseSafeDatum(utxo.datum, MyDatum);

// ❌ — unsafe, no Effect error, crashes on missing/malformed datum
const myDatum = Data.from(utxo.datum!, MyDatum);
```

For union datums that need a cast:

```typescript
const myDatum = (yield *
  parseSafeDatum(utxo.datum, MyDatum)) as unknown as MyDatum;
```

### `getWalletAddress(lucid)` — always hoist, never inline

```typescript
// ✅ — hoisted at top of Effect.gen, used throughout
const address = yield* getWalletAddress(lucid);

// ❌ — never inline in .pay.ToAddress() or .addSigner()
.addSigner(await lucid.wallet().address())
```

### `getScriptAddress(lucid, validator)` — returns Effect

```typescript
const scriptAddress = yield * getScriptAddress(lucid, myValidator.spend);
```

### `RedeemerBuilder` — required for any redeemer referencing input indices

```typescript
// ✅ — Lucid resolves indices at build time
const redeemer: RedeemerBuilder = {
  kind: "selected",
  makeRedeemer: (inputIndices: bigint[]) =>
    Data.to(
      {
        MyVariant: {
          group_input_index: inputIndices[0],
          member_input_index: inputIndices[1],
        },
      },
      MyRedeemer,
    ),
  inputs: [groupUtxo, memberUtxo], // same order as inputIndices
};

// ❌ — never hardcode indices
const redeemer = Data.to({ MyVariant: { group_input_index: 0n } }, MyRedeemer);
```

### `signAndSubmit(tx)` — signs with current wallet and submits

```typescript
const txHash = yield * signAndSubmit(tx);
```

### `waitForTx(lucid, txHash)` — polls until indexed

```typescript
yield * waitForTx(lucid, txHash); // default: 5s interval, 24 retries
yield * waitForTx(lucid, txHash, 3000, 10); // custom interval + retries
```

---

## CIP-68 token names

```typescript
import { createCip68TokenNames, findCip68TokenPair } from "../core/utils/index.js";

// Create names from a UTxO outref (deterministic, unique)
const { refTokenName, userTokenName } = yield* createCip68TokenNames(selectedUtxo);

// Mint both
.mintAssets({
  [policyId + refTokenName]:  1n,   // 000643b0... — reference token (locked at script)
  [policyId + userTokenName]: 1n,   // 000de140... — user token (sent to wallet)
}, redeemer)

// Find an existing pair
const { refUtxo, userUtxo } = yield* findCip68TokenPair(lucid, policyId, tokenBaseName);
```

---

## Test setup chain

Build composable setup functions that extend a base result. Each level calls the one above:

```typescript
// test/setup.ts

export type BaseSetup = {
  network: Network;
  context: LucidContext; // { lucid, users, emulator }
  scripts: MyValidators;
};

export const setupBase = (): Effect.Effect<BaseSetup, Error, never> =>
  Effect.gen(function* () {
    const { lucid, users, emulator } = yield* makeLucidContext();
    const scripts = yield* makeValidators(lucid.config().network!);
    return {
      network: lucid.config().network!,
      context: { lucid, users, emulator },
      scripts,
    };
  });

export const setupEntity = (
  base: BaseSetup,
  overrides?: Partial<EntityDatum>,
) =>
  Effect.gen(function* () {
    const { txHash, outputs } = yield* createEntityTestCase(base.context, {
      overrides,
    });
    if (base.context.emulator)
      yield* Effect.sync(() => base.context.emulator!.awaitBlock(5));
    return { ...base, entityUtxo: outputs.entityUtxo };
  });
```

Factory functions for default datums — always accept `overrides?`:

```typescript
// test/utils.ts
export const createDefaultGroupDatum = (
  overrides?: Partial<GroupDatum>,
): GroupDatum => ({
  contribution_fee: 10_000_000n,
  num_intervals: 10n,
  interval_length: 3_600_000n, // 1 hour in ms
  member_count: 0n,
  start_time: BigInt(Date.now()),
  is_active: true,
  admin_pkh: "aabb...",
  ...overrides,
});
```

Test files use `it.effect()` from `@effect/vitest`:

```typescript
import { it, describe, expect } from "@effect/vitest";
import { Effect } from "effect";

describe("myOperation", () => {
  it.effect("succeeds with valid config", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { entityUtxo } = yield* setupEntity(base);
      const tx = yield* unsignedMyOperationTxProgram(base.context.lucid, {
        utxo: entityUtxo,
      });
      expect(tx).toBeDefined();
    }),
  );
});
```

---

## Multi-provider test context (`test/context.ts`)

The test context supports four providers via environment variables:

| Env                       | Provider              |
| ------------------------- | --------------------- |
| none (default)            | Lucid Emulator        |
| `MAESTRO_API_KEY`         | Maestro (Preprod)     |
| `BLOCKFROST_KEY`          | Blockfrost (Preprod)  |
| `OGMIOS_URL` + `KUPO_URL` | Kupmios (custom node) |

`NETWORK` env var sets the network (default: `Preprod`).

---

## CIP-68 on-chain identity — token suffix, not UTxO reference

**Never save a `txHash + outputIndex` as the durable identity of a CIP-68 entity.** Every spend
invalidates those coordinates. Save the **token suffix** instead — the 28-byte hex string derived
from the mint `OutputReference` via `blake2b_256(cbor(outref))[0..28]`. It never changes.

```typescript
// ✅ Correct — permanent, survives every update/withdraw
state.accountTokenSuffix =
  "181aee6df0d0a437ee3ef1e197ec133f8b1a83adc256472e2082f70b";

// ❌ Wrong — stale after the next transaction that spends the UTxO
state.accountUtxo = { txHash: "30135f...", outputIndex: 0 };
```

**Endpoint configs take `tokenSuffix: string`, not `UTxO` objects.** The SDK resolves the current
UTxO on-chain via `lucid.utxoByUnit(policyId + prefix + suffix)` at call time. Callers never need to
track which UTxO holds the token — only the suffix.

**In examples / scripts:**

- After `createAccount` / `createGroup`: fetch output 0 via `lucid.utxosByOutRef`, extract the
  `prefix100` token key, slice off `policyId + prefix100` to get the suffix, write it to `state.json`.
- All subsequent scripts load the suffix and pass it directly — no UTxO queries needed by the caller.

**`resolveUtxoByUnit(lucid, unit)`** (in `src/core/utils/resolve.ts`) wraps `lucid.utxoByUnit` in
an Effect that fails with `UtxoNotFoundError` on `undefined` (emulator) or network error:

```typescript
export const resolveUtxoByUnit = (
  lucid: LucidEvolution,
  unit: string,
): Effect.Effect<UTxO, UtxoNotFoundError> =>
  Effect.tryPromise({
    try: () => lucid.utxoByUnit(unit),
    catch: () => new UtxoNotFoundError({ tokenName: unit, address: "chain" }),
  }).pipe(
    Effect.filterOrFail(
      (utxo): utxo is UTxO => utxo != null,
      () => new UtxoNotFoundError({ tokenName: unit, address: "chain" }),
    ),
  );
```

---

## Common mistakes

| Mistake                                             | Fix                                                         |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `.complete()` on tx                                 | Use `completeProgram()` — returns Effect                    |
| `Data.from(datum!)`                                 | Use `parseSafeDatum(datum, Schema)`                         |
| `lucid.wallet().address()` inline                   | Hoist: `yield* getWalletAddress(lucid)`                     |
| Hardcoded input index in redeemer                   | Use `RedeemerBuilder { kind: "selected" }`                  |
| Missing `makeReturn()` on endpoint                  | Every exported endpoint needs it                            |
| Missing `Effect.mapError` on `completeProgram()`    | Always pipe to `TransactionBuildError`                      |
| Batching multiple endpoints in one commit           | One commit per endpoint (after tests pass)                  |
| Changing a datum type without updating spec first   | Update spec → update types → retest                         |
| Saving `{ txHash, outputIndex }` as entity identity | Save `tokenSuffix` — survives every spend                   |
| Passing `UTxO` objects in endpoint configs          | Configs take `tokenSuffix: string`; SDK resolves UTxOs      |
| Calling `lucid.utxoByUnit()` directly in endpoint   | Use `resolveUtxoByUnit()` — handles `undefined` on emulator |
