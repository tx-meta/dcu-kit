import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import pkg from "../package.json" with { type: "json" };
import roscaBlueprint from "../src/core/plutus.json" with { type: "json" };
import escrowBlueprint from "../src/escrow/plutus.json" with { type: "json" };
import savingsBlueprint from "../src/savings/plutus.json" with { type: "json" };
import governanceBlueprint from "../src/governance/plutus.json" with { type: "json" };
import {
  validatorRegistry,
  familyStatus,
  launchFamilies,
  isDeployAllowed,
  FamilyName,
} from "../src/core/validators/registry.js";

// The registry is the reviewed record tying an SDK version to the exact
// validator bytes it ships (VERSIONING.md). scripts/check-validator-registry.mjs
// is the repo-level gate; this suite pins the runtime view the SDK exports.

type Validator = { title: string; compiledCode: string };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const blueprints: Record<FamilyName, { validators: Validator[] }> = {
  rosca: roscaBlueprint as never,
  escrow: escrowBlueprint as never,
  savings: savingsBlueprint as never,
  governance: governanceBlueprint as never,
};

describe("validator registry", () => {
  it("records the published SDK version", () => {
    expect(validatorRegistry.sdkVersion).toBe(pkg.version);
  });

  it("fingerprints every bundled validator, and nothing else", () => {
    for (const family of Object.keys(blueprints) as FamilyName[]) {
      const fam = validatorRegistry.families[family];
      const titles = blueprints[family].validators
        .filter((v) => v.title && v.compiledCode)
        .map((v) => v.title);
      expect(Object.keys(fam.validators).sort()).toEqual([...titles].sort());
      for (const v of blueprints[family].validators) {
        expect(fam.validators[v.title]).toBe(sha256(v.compiledCode));
      }
    }
  });

  it("freezes the launch surface to rosca + escrow", () => {
    expect(launchFamilies().sort()).toEqual(["escrow", "rosca"]);
    expect(familyStatus("savings")).toBe("experimental");
    expect(familyStatus("governance")).toBe("experimental");
  });

  it("blocks Mainnet deployment of experimental families only", () => {
    expect(isDeployAllowed("rosca", "Mainnet")).toBe(true);
    expect(isDeployAllowed("savings", "Mainnet")).toBe(false);
    expect(isDeployAllowed("governance", "Mainnet")).toBe(false);
    expect(isDeployAllowed("governance", "Preprod")).toBe(true);
    expect(isDeployAllowed("savings", "Custom")).toBe(true);
  });
});
