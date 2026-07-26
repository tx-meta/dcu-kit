import { describe, expect, it } from "vitest";
import { validatorToScriptHash } from "@lucid-evolution/lucid";
import { loadDeployment } from "../src/core/deployments/index.js";
import { buildProtocol } from "../src/core/validators/constants.js";
import { buildGovernance } from "../src/governance/validators.js";
import { savingsVaultValidator } from "../src/savings/validators.js";
import { escrowV2Validator } from "../src/escrow/v2/validators.js";
import packageJson from "../package.json" with { type: "json" };

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

  it("records hashes for all six ROSCA refs that match buildProtocol(settingsPolicy)", () => {
    const d = loadDeployment("Preprod");
    const protocol = buildProtocol(d.settingsPolicy);

    expect(d.refScripts.treasury.scriptHash).toBe(
      validatorToScriptHash(protocol.treasuryValidator.mintTreasury),
    );
    expect(d.refScripts.group.scriptHash).toBe(
      validatorToScriptHash(protocol.groupValidator.spendGroup),
    );
    expect(d.refScripts.treasuryRounds.scriptHash).toBe(
      validatorToScriptHash(protocol.treasuryStakeValidators.rounds),
    );
    expect(d.refScripts.treasuryLifecycle.scriptHash).toBe(
      validatorToScriptHash(protocol.treasuryStakeValidators.lifecycle),
    );
    expect(d.refScripts.treasuryRecovery.scriptHash).toBe(
      validatorToScriptHash(protocol.treasuryStakeValidators.recovery),
    );
    expect(d.refScripts.treasuryReserve.scriptHash).toBe(
      validatorToScriptHash(protocol.treasuryStakeValidators.reserve),
    );
  });

  it("records governance hashes that match buildGovernance(governance.seed)", () => {
    const d = loadDeployment("Preprod");
    const instance = buildGovernance(d.governance.seed);

    expect(d.refScripts.governanceDispatcher.scriptHash).toBe(
      instance.govPolicy,
    );
    expect(d.refScripts.governanceVoting.scriptHash).toBe(
      instance.votingStakeHash,
    );
    expect(d.governance.govPolicy).toBe(instance.govPolicy);
    expect(d.governance.gateHash).toBe(instance.gateHash);
    expect(d.governance.votingStakeHash).toBe(instance.votingStakeHash);
    expect(d.governance.settingsPolicy).toBe(instance.settingsPolicy);
  });

  it("ties the manifest sdkVersion to the published package version", () => {
    const d = loadDeployment("Preprod");
    expect(d.sdkVersion).toBe(packageJson.version);
  });
});
