import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import {
  operationDescriptors,
  operationRequirements,
  treasuryFamilyReferenceKey,
} from "../src/core/index.js";

describe("generated operation reference requirements", () => {
  it("derives every family reference from the attachment source of truth", () => {
    for (const [operation, descriptor] of Object.entries(
      operationDescriptors,
    )) {
      for (const family of descriptor.treasuryFamilies) {
        expect(operationRequirements[operation as "distributeRound"]).toContain(
          treasuryFamilyReferenceKey[family],
        );
      }
    }
  });

  it("publishes complete requirements for size-sensitive operations", () => {
    expect(operationRequirements.beginRecommit).toEqual(["group"]);
    expect(operationRequirements.distributeRound).toEqual([
      "treasury",
      "group",
      "treasuryRounds",
    ]);
  });

  it("keeps every configurable ROSCA reference-script endpoint behind a live guard", () => {
    const endpointFiles = globSync("src/endpoints/*.ts");
    const unguarded = endpointFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        source.includes("scriptRefs?:") &&
        !source.includes("attachFamilyWithdrawal(") &&
        !source.includes("requirementsFor(")
      );
    });
    expect(unguarded).toEqual([]);
  });
});
