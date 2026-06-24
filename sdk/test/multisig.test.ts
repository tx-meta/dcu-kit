import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Emulator, generateEmulatorAccount, Lucid, PROTOCOL_PARAMETERS_DEFAULT } from "@lucid-evolution/lucid";
import { buildMultisig } from "../src/core/utils/index.js";

// Three deterministic-looking payment key hashes (28 bytes = 56 hex chars each)
const KEY_A = "a".repeat(56);
const KEY_B = "b".repeat(56);
const KEY_C = "c".repeat(56);

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
