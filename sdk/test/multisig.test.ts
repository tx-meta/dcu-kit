import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  Emulator,
  generateEmulatorAccount,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
} from "@lucid-evolution/lucid";
import {
  buildMultisig,
  assetNameLabels,
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/utils/index.js";
import { unsignedAssignAdminTxProgram } from "../src/endpoints/assignAdmin.js";
import { setupBase, setupGroup } from "./setup.js";
import { advanceBlock } from "./effects.js";
import { extractTokenSuffix } from "./utils.js";

// Three deterministic-looking payment key hashes (28 bytes = 56 hex chars each)
const KEY_A = "a".repeat(56);
const KEY_B = "b".repeat(56);
const KEY_C = "c".repeat(56);

// Golden hash: the exact policyHash (native script hash) buildMultisig produces for
// an `atLeast 2 of [KEY_A, KEY_B, KEY_C]` script. The script is opaque CBOR, so this
// pins the M/N structure — any inversion of `required` vs `signers.length` (e.g. a
// 3-of-3 or a different member order) changes the hash and fails this assertion.
const GOLDEN_2_OF_3_HASH =
  "dcc7bc8d59c400a2a699f1756e4a18ae92c900ea173cab2f92c24290";

const makeTestLucid = () =>
  Effect.promise(async () => {
    const acct = generateEmulatorAccount({ lovelace: 5_000_000n });
    const emulator = new Emulator([acct], PROTOCOL_PARAMETERS_DEFAULT);
    return Lucid(emulator, "Custom");
  });

describe("buildMultisig", () => {
  it("returns an atLeast script, enterprise address, and deterministic policyHash", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const result = await Effect.runPromise(
      buildMultisig(lucid, {
        signers: [KEY_A, KEY_B, KEY_C],
        required: 2,
      }),
    );

    // Script type must be Native
    expect(result.script.type).toBe("Native");

    // Address must be a script (enterprise) address on Custom network
    // Enterprise addresses on Custom begin with "addr_test1w" (script) or "addr_test1q" (key)
    // Native script addresses use script credential → "addr_test1w"
    expect(result.address).toMatch(/^addr_test1w/);

    // policyHash is a 28-byte / 56-hex-char script hash
    expect(result.policyHash).toHaveLength(56);
    expect(result.policyHash).toMatch(/^[0-9a-f]+$/);

    // Golden-hash assertion: pins the exact atLeast-2-of-3 structure. Catches any
    // M/N inversion without deserialising the opaque script CBOR.
    expect(result.policyHash).toBe(GOLDEN_2_OF_3_HASH);
  });

  it("policyHash is deterministic for identical inputs", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const r1 = await Effect.runPromise(
      buildMultisig(lucid, { signers: [KEY_A, KEY_B, KEY_C], required: 2 }),
    );
    const r2 = await Effect.runPromise(
      buildMultisig(lucid, { signers: [KEY_A, KEY_B, KEY_C], required: 2 }),
    );

    expect(r1.policyHash).toBe(r2.policyHash);
    expect(r1.address).toBe(r2.address);
  });

  it("fails when required > signers.length", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const result = await Effect.runPromise(
      Effect.either(
        buildMultisig(lucid, { signers: [KEY_A, KEY_B], required: 3 }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("ConfigurationError");
    }
  });

  it("fails when required < 1", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const result = await Effect.runPromise(
      Effect.either(
        buildMultisig(lucid, { signers: [KEY_A, KEY_B], required: 0 }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("ConfigurationError");
    }
  });

  it("fails when required is non-integer", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const result = await Effect.runPromise(
      Effect.either(
        buildMultisig(lucid, { signers: [KEY_A, KEY_B, KEY_C], required: 1.5 }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("ConfigurationError");
    }
  });

  it("fails when signers array is empty", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const result = await Effect.runPromise(
      Effect.either(
        buildMultisig(lucid, { signers: [], required: 1 }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("ConfigurationError");
    }
  });
});

describe("assignAdmin", () => {
  // TDD: this test was written RED (endpoint missing) before assignAdmin.ts existed.
  // Verifies that the group 222 admin token moves from the VK wallet to a
  // buildMultisig script address after calling assignAdmin.
  it.effect(
    "transfers the 222 admin token from wallet to a multisig script address",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context } = base;
        const { lucid, users, emulator } = context;

        // Create a group with the VK admin wallet; admin 222 token lands in admin wallet.
        // setupGroup doesn't surface the suffix directly — extract it from adminUtxo.
        const { adminUtxo } = yield* setupGroup(base);
        const groupTokenSuffix = extractTokenSuffix(
          adminUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix222,
        );

        // Build a 2-of-3 multisig — its address is the destination for assignAdmin.
        const KEY_A = "a".repeat(56);
        const KEY_B = "b".repeat(56);
        const KEY_C = "c".repeat(56);
        const multisig = yield* buildMultisig(lucid, {
          signers: [KEY_A, KEY_B, KEY_C],
          required: 2,
        });

        // Admin wallet still selected from setupGroup.
        selectWalletFromSeed(lucid, users.admin.seedPhrase);

        const adminUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix222 +
          groupTokenSuffix;

        const tx = yield* unsignedAssignAdminTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            destinationAddress: multisig.address,
          },
        );
        const txHash = yield* signAndSubmit(tx);
        yield* advanceBlock(emulator);

        // The 222 admin token must now be at the multisig script address.
        const multisigUtxos = yield* Effect.tryPromise(() =>
          lucid.utxosAt(multisig.address),
        );
        const adminAtMultisig = multisigUtxos.find(
          (u) => u.txHash === txHash && u.assets[adminUnit] === 1n,
        );
        expect(adminAtMultisig).toBeDefined();
        expect(adminAtMultisig!.assets[adminUnit]).toBe(1n);
      }),
  );
});
