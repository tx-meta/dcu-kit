import { describe, expect, it } from "vitest";
import { validatorToScriptHash } from "@lucid-evolution/lucid";
import { loadDeployment } from "../src/core/deployments/index.js";
import { buildProtocol } from "../src/core/validators/constants.js";
import { buildGovernance } from "../src/governance/validators.js";
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

  it("keeps unchanged escrow refs current while savings remains pinned", () => {
    const d = loadDeployment("Preprod");
    expect(d.refScripts.savings.scriptHash).not.toBe(
      validatorToScriptHash(savingsVaultValidator.spendVault),
    );
    expect(d.refScripts.escrowV2.scriptHash).toBe(
      validatorToScriptHash(escrowV2Validator.spendEscrow),
    );
  });

  it("marks changed refs as legacy until the candidate hashes are deployed", () => {
    const d = loadDeployment("Preprod");
    const protocol = buildProtocol(d.settingsPolicy);

    expect(d.status).toBe("legacy-validator-set");
    expect(d.sdkVersion).toBe("0.6.0-preprod.0");
    expect(d.refScripts.group.scriptHash).not.toBe(
      validatorToScriptHash(protocol.groupValidator.spendGroup),
    );
    expect(d.refScripts.treasuryRounds.scriptHash).not.toBe(
      validatorToScriptHash(protocol.treasuryStakeValidators.rounds),
    );

    // The other four applied ROSCA scripts did not move in ADR-R1.
    expect(d.refScripts.treasury.scriptHash).toBe(
      validatorToScriptHash(protocol.treasuryValidator.mintTreasury),
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

  it("keeps the internally consistent legacy governance instance pinned", () => {
    const d = loadDeployment("Preprod");
    const instance = buildGovernance(d.governance.seed);

    expect(d.refScripts.governanceDispatcher.scriptHash).not.toBe(
      instance.govPolicy,
    );
    expect(d.refScripts.governanceVoting.scriptHash).not.toBe(
      instance.votingStakeHash,
    );
    expect(d.governance.govPolicy).toBe(
      d.refScripts.governanceDispatcher.scriptHash,
    );
    expect(d.governance.votingStakeHash).toBe(
      d.refScripts.governanceVoting.scriptHash,
    );
    expect(d.governance.govPolicy).not.toBe(instance.govPolicy);
    expect(d.governance.gateHash).not.toBe(instance.gateHash);
    expect(d.governance.votingStakeHash).not.toBe(instance.votingStakeHash);
    expect(d.governance.settingsPolicy).not.toBe(instance.settingsPolicy);
  });
});
