import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect } from "effect";
import {
  getTxMessage,
  type BlockfrostConfig,
} from "../src/queries/getTxMessage.js";
import { hashContent } from "../src/core/utils/index.js";

const TX = "ab".repeat(32);

const config: BlockfrostConfig = {
  url: "https://bf.test/api/v0",
  projectId: "test",
};

const json = (body: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as Response);

const notFound = () =>
  Promise.resolve({
    ok: false,
    status: 404,
    json: () => Promise.resolve(null),
    text: () => Promise.resolve(""),
  } as Response);

afterEach(() => vi.restoreAllMocks());

describe("getTxMessage", () => {
  it("joins the CIP-20 msg chunks back into the original text", async () => {
    // Blockfrost returns label 674 with the msg array exactly as chunked on write.
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      json([
        {
          label: "674",
          json_metadata: { msg: ["Kiambu land", "-buying chama"] },
        },
      ]),
    );

    const text = await Effect.runPromise(getTxMessage(config, TX));
    expect(text).toBe("Kiambu land-buying chama");
  });

  it("round-trips a hash commitment written by hashContent", async () => {
    const terms = "Milestone 1: foundation poured";
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      json([{ label: "674", json_metadata: { msg: [terms] } }]),
    );

    const text = await Effect.runPromise(getTxMessage(config, TX));
    // The doc's read path: recompute and compare against the datum commitment.
    expect(hashContent(text!)).toBe(
      "f908b293338c4ebf3ddce8192d178f72a568dd4eedf7ece8327d76a30890513d",
    );
  });

  it("returns null when the transaction carries no metadata at all", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => json([]));

    expect(await Effect.runPromise(getTxMessage(config, TX))).toBeNull();
  });

  it("returns null when the transaction has metadata but no 674 label", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      json([{ label: "721", json_metadata: { name: "an NFT" } }]),
    );

    expect(await Effect.runPromise(getTxMessage(config, TX))).toBeNull();
  });

  it("returns null for an unknown transaction (Blockfrost 404)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(notFound);

    expect(await Effect.runPromise(getTxMessage(config, TX))).toBeNull();
  });

  it("accepts a bare string msg as well as an array", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      json([{ label: "674", json_metadata: { msg: "single line" } }]),
    );

    expect(await Effect.runPromise(getTxMessage(config, TX))).toBe(
      "single line",
    );
  });

  it("ignores a 674 label whose payload is not a CIP-20 message", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      json([{ label: "674", json_metadata: { other: "not a msg" } }]),
    );

    expect(await Effect.runPromise(getTxMessage(config, TX))).toBeNull();
  });
});
