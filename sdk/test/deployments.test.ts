import { describe, expect, it } from "vitest";
import { validatorToScriptHash } from "@lucid-evolution/lucid";
import { loadDeployment } from "../src/core/deployments/index.js";
import { savingsVaultValidator } from "../src/savings/validators.js";
import { escrowV2Validator } from "../src/escrow/v2/validators.js";

describe("deployment manifest", () => {
  it("pins a settings policy and every module ref script", () => {
    const d = loadDeployment("Preprod");
    expect(d.settingsPolicy).toBe(
      "138efe0f9ceb96441b24d2bf72a7dc43e74692004dd1b2c2d1ace48d",
    );
    for (const key of [
      "treasury",
      "group",
      "treasuryRounds",
      "treasuryLifecycle",
      "treasuryRecovery",
      "treasuryReserve",
      "savings",
      "escrowV2",
      "governanceDispatcher",
      "governanceVoting",
    ]) {
      expect(d.refScripts[key]?.txHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("records hashes that match the compiled validators", () => {
    const d = loadDeployment("Preprod");
    expect(d.refScripts.savings.scriptHash).toBe(
      validatorToScriptHash(savingsVaultValidator.spendVault),
    );
    expect(d.refScripts.escrowV2.scriptHash).toBe(
      validatorToScriptHash(escrowV2Validator.spendEscrow),
    );
  });
});
