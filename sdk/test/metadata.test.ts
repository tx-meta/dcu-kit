import { describe, expect, it } from "vitest";
import { type Data, fromText } from "@lucid-evolution/lucid";
import { getGroupMetadata, getGroupName } from "../src/core/utils/index.js";

// Builds a `{ metadata }` source matching how Lucid deserialises the on-chain
// CIP-68 metadata: a Map of hex(key) → hex(value).
const meta = (entries: Record<string, string>): { metadata: Data } => {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(entries)) m.set(fromText(k), fromText(v));
  return { metadata: m as unknown as Data };
};

describe("getGroupMetadata", () => {
  it("decodes a populated map to a plain UTF-8 Record", () => {
    expect(
      getGroupMetadata(
        meta({ name: "Savings Club", description: "Monthly ROSCA" }),
      ),
    ).toEqual({ name: "Savings Club", description: "Monthly ROSCA" });
  });

  it("returns an empty object for an empty map", () => {
    expect(getGroupMetadata(meta({}))).toEqual({});
  });

  it("returns an empty object when metadata is not a Map", () => {
    expect(
      getGroupMetadata({ metadata: "deadbeef" as unknown as Data }),
    ).toEqual({});
  });
});

describe("getGroupName", () => {
  it("returns the decoded name when present", () => {
    expect(getGroupName(meta({ name: "Savings Club" }))).toBe("Savings Club");
  });

  it("returns undefined when the name key is absent", () => {
    expect(getGroupName(meta({ description: "no name here" }))).toBeUndefined();
  });

  it("returns an empty string when the name is empty", () => {
    expect(getGroupName(meta({ name: "" }))).toBe("");
  });
});
