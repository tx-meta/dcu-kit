import { describe, expect, it } from "vitest";
import { computeProfileCommitment } from "../src/core/utils/profileCommitment.js";

const SALT_0 = "00".repeat(32);
const SALT_1 = "00".repeat(31) + "01";
const SALT_F = "ff".repeat(32);

describe("computeProfileCommitment", () => {
  it("matches the fixed vectors", () => {
    // Vectors generated once from this implementation and frozen — external
    // consumers (Kyama, independent verifiers) must reproduce these. Changing
    // them is a breaking change to the commitment scheme.
    expect(computeProfileCommitment("", SALT_0)).toBe(
      "2e6e16e1f7d7f90d88aba1668137b934e767212d6103cc2b5c4ac4b7a68cd7a3",
    );
    expect(computeProfileCommitment("@alice", SALT_1)).toBe(
      "1abdc30d9ad56932f170edcd369f3d026d9151737e1d7c6506b92391fb661618",
    );
    expect(computeProfileCommitment("chama ya wamama 🌍", SALT_F)).toBe(
      "da41d85858a496e3ebcb44882dd58e59f983b32051608df2037f897fa1cef382",
    );
  });

  it("is salt-sensitive and profile-sensitive", () => {
    expect(computeProfileCommitment("@alice", SALT_0)).not.toBe(
      computeProfileCommitment("@alice", SALT_1),
    );
    expect(computeProfileCommitment("@alice", SALT_0)).not.toBe(
      computeProfileCommitment("@alicf", SALT_0),
    );
  });

  it("rejects malformed salts", () => {
    expect(() => computeProfileCommitment("x", "00")).toThrow();
    expect(() => computeProfileCommitment("x", "zz".repeat(32))).toThrow();
    expect(() => computeProfileCommitment("x", SALT_0 + "00")).toThrow();
  });

  it("returns lowercase 64-char hex and accepts uppercase salt input", () => {
    const out = computeProfileCommitment("x", SALT_F.toUpperCase());
    expect(out).toMatch(/^[0-9a-f]{64}$/);
    expect(out).toBe(computeProfileCommitment("x", SALT_F));
  });
});
