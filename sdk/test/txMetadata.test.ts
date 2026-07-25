import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase, setupMembership } from "./setup.js";
import { createGroupTestCase } from "./actions.js";
import { unsignedContributeTxProgram } from "../src/endpoints/contribute.js";
import {
  assetNameLabels,
  selectWalletFromSeed,
} from "../src/core/utils/index.js";
import { extractTokenSuffix, readCip20 } from "./utils.js";
import {
  CIP20_LABEL,
  MAX_PROPOSAL_MESSAGE_BYTES,
  MAX_TX_MESSAGE_BYTES,
  buildCip20Payload,
  chunkUtf8,
  hashContent,
} from "../src/core/utils/txMetadata.js";

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

describe("chunkUtf8", () => {
  it("returns a single chunk when the text fits the byte limit", () => {
    expect(chunkUtf8("Kiambu land-buying chama", 64)).toEqual([
      "Kiambu land-buying chama",
    ]);
  });

  it("splits ASCII text on the byte limit", () => {
    const text = "a".repeat(65);
    expect(chunkUtf8(text, 64)).toEqual(["a".repeat(64), "a"]);
  });

  it("never splits a multi-byte codepoint across chunks", () => {
    // 🌍 is 4 UTF-8 bytes. 62 ASCII bytes + 🌍 = 66 bytes, so the emoji
    // straddles a naive 64-byte cut and must move whole into chunk two.
    const text = "a".repeat(62) + "🌍";
    const chunks = chunkUtf8(text, 64);

    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => utf8Len(c) <= 64)).toBe(true);
    expect(chunks[1]).toBe("🌍");
  });
});

describe("buildCip20Payload", () => {
  it("uses the CIP-20 transaction-message label", () => {
    expect(CIP20_LABEL).toBe(674);
  });

  it("wraps a short single line under the msg key", () => {
    expect(Effect.runSync(buildCip20Payload("Round 3 payout"))).toEqual({
      msg: ["Round 3 payout"],
    });
  });

  it("chunks a line longer than 64 bytes into several msg entries", () => {
    const line = "b".repeat(100);
    const { msg } = Effect.runSync(buildCip20Payload(line));

    expect(msg).toEqual(["b".repeat(64), "b".repeat(36)]);
  });

  it("preserves caller line breaks when given an array", () => {
    const { msg } = Effect.runSync(
      buildCip20Payload(["Loan purpose", "school fees"]),
    );

    expect(msg).toEqual(["Loan purpose", "school fees"]);
  });

  it("fails with ConfigurationError when the message is empty", () => {
    const error = Effect.runSync(Effect.flip(buildCip20Payload("")));

    expect(error._tag).toBe("ConfigurationError");
    expect(error.configKey).toBe("message");
  });

  it("accepts a larger explicit budget than the default", () => {
    // Governance rationale: low-frequency, high-stakes, so it buys headroom the
    // default deliberately withholds from routine per-action memos.
    const long = "r".repeat(MAX_TX_MESSAGE_BYTES + 1);
    const { msg } = Effect.runSync(
      buildCip20Payload(long, MAX_PROPOSAL_MESSAGE_BYTES),
    );

    expect(msg.join("")).toBe(long);
  });

  it("still enforces the explicit budget once exceeded", () => {
    const tooLong = "r".repeat(MAX_PROPOSAL_MESSAGE_BYTES + 1);
    const error = Effect.runSync(
      Effect.flip(buildCip20Payload(tooLong, MAX_PROPOSAL_MESSAGE_BYTES)),
    );

    expect(error._tag).toBe("ConfigurationError");
    expect(error.message).toContain(String(MAX_PROPOSAL_MESSAGE_BYTES));
  });

  it("fails with ConfigurationError when the message exceeds the byte budget", () => {
    const tooLong = "c".repeat(MAX_TX_MESSAGE_BYTES + 1);
    const error = Effect.runSync(Effect.flip(buildCip20Payload(tooLong)));

    expect(error._tag).toBe("ConfigurationError");
    expect(error.message).toContain(String(MAX_TX_MESSAGE_BYTES));
  });
});

describe("hashContent", () => {
  it("matches plain BLAKE2b-256 vectors from an independent implementation", () => {
    // Generated with GNU coreutils `b2sum -l 256`, not with this SDK's own
    // hashing library. Unlike computeProfileCommitment there is no salt and no
    // domain tag: escrow terms and evidence must be verifiable by anyone
    // holding the public pre-image, including tools that know nothing of
    // dcu-kit. Salting is what protects a low-entropy profile commitment from
    // brute force; here it would only make independent verification impossible.
    expect(hashContent("")).toBe(
      "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
    );
    expect(hashContent("Milestone 1: foundation poured")).toBe(
      "f908b293338c4ebf3ddce8192d178f72a568dd4eedf7ece8327d76a30890513d",
    );
    expect(hashContent("chama ya wamama 🌍")).toBe(
      "321122d8b9931e0a6466e677442fd368818b5ceab27d32124e563a22cffd1bf6",
    );
  });

  it("returns lowercase 64-char hex", () => {
    expect(hashContent("terms v1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the exact bytes given, applying no Unicode normalization", () => {
    // Precomposed U+00E9 vs decomposed e + U+0301 render identically but are
    // different byte strings, so a holder must retain the pre-image
    // byte-for-byte to reproduce the hash.
    expect(hashContent("caf\u00e9")).not.toBe(hashContent("cafe\u0301"));
  });
});

describe("CIP-20 message on createGroup", () => {
  it.effect("attaches the caller's message under label 674", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { txCbor } = yield* createGroupTestCase(base.context, {
        message: "Kiambu land-buying chama",
      });

      const payload = readCip20(txCbor);
      expect(payload).toBeDefined();
      // Shape must be the CIP-20 `{ msg: [...] }` map wallets and explorers
      // look for, not merely a blob that happens to contain the text.
      expect(JSON.parse(payload!)).toEqual({
        map: [
          {
            k: { string: "msg" },
            v: { list: [{ string: "Kiambu land-buying chama" }] },
          },
        ],
      });
    }),
  );

  it.effect("attaches no auxiliary metadata when no message is given", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { txCbor } = yield* createGroupTestCase(base.context);

      expect(readCip20(txCbor)).toBeUndefined();
    }),
  );
});

describe("CIP-20 message on contribute", () => {
  it.effect("carries a member's payment memo into the built transaction", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo, userUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      const groupTokenSuffix = extractTokenSuffix(
        groupUtxo,
        context.protocol!.groupPolicyId,
        assetNameLabels.prefix100,
      );
      const accountTokenSuffix = extractTokenSuffix(
        userUtxo,
        context.protocol!.accountPolicyId,
        assetNameLabels.prefix222,
      );

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const tx = yield* unsignedContributeTxProgram(context.protocol!, lucid, {
        groupTokenSuffix,
        accountTokenSuffix,
        scriptRefs: context.scriptRefs,
        topUpAmount: 2_000_000n,
        message: "March contribution",
      });

      expect(readCip20(tx.toCBOR())).toContain("March contribution");
    }),
  );
});
