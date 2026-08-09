import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { LucidEvolution, OutRef, UTxO } from "@lucid-evolution/lucid";
import {
  resolveUtxoByOutRef,
  resolveUtxoByUnit,
} from "../src/core/utils/resolve.js";

const outRef: OutRef = { txHash: "ab".repeat(32), outputIndex: 1 };
const lucidWith = (f: () => Promise<UTxO[]>): LucidEvolution =>
  ({ utxosByOutRef: f }) as unknown as LucidEvolution;
const lucidUnitWith = (f: () => Promise<UTxO>): LucidEvolution =>
  ({ utxoByUnit: f }) as unknown as LucidEvolution;

describe("resolveUtxoByOutRef error distinction", () => {
  it("reports an empty successful provider response as not found", async () => {
    const result = await Effect.runPromiseExit(
      resolveUtxoByOutRef(
        lucidWith(async () => []),
        outRef,
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && result.cause._tag === "Fail") {
      expect(result.cause.error._tag).toBe("UtxoNotFoundError");
    }
  });

  it("preserves a provider outage as LucidError with its cause", async () => {
    const outage = new Error("provider 503");
    const result = await Effect.runPromiseExit(
      resolveUtxoByOutRef(
        lucidWith(async () => {
          throw outage;
        }),
        outRef,
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && result.cause._tag === "Fail") {
      expect(result.cause.error).toMatchObject({
        _tag: "LucidError",
        cause: outage,
      });
    }
  });
});

describe("resolveUtxoByUnit error distinction", () => {
  it("keeps an explicit provider absence as not found", async () => {
    const result = await Effect.runPromiseExit(
      resolveUtxoByUnit(
        lucidUnitWith(async () => {
          throw new Error("UTxO not found for unit");
        }),
        "ab",
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && result.cause._tag === "Fail")
      expect(result.cause.error._tag).toBe("UtxoNotFoundError");
  });

  it("preserves a provider outage instead of calling it absence", async () => {
    const outage = new Error("provider 503");
    const result = await Effect.runPromiseExit(
      resolveUtxoByUnit(
        lucidUnitWith(async () => {
          throw outage;
        }),
        "ab",
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && result.cause._tag === "Fail")
      expect(result.cause.error).toMatchObject({
        _tag: "LucidError",
        cause: outage,
      });
  });

  it("keeps multi-match responses distinct from both", async () => {
    const result = await Effect.runPromiseExit(
      resolveUtxoByUnit(
        lucidUnitWith(async () => {
          throw new Error(
            "Unit needs to be an NFT or only held by one address",
          );
        }),
        "ab",
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && result.cause._tag === "Fail")
      expect(result.cause.error._tag).toBe("AmbiguousUtxoError");
  });
});
