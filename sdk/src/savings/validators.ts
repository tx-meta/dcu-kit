import {
  applyParamsToScript,
  mintingPolicyToId,
  Network,
  Script,
  validatorToRewardAddress,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import blueprint from "./plutus.json" with { type: "json" };
import {
  Blueprint,
  getScript,
  readValidators,
} from "../core/validators/reader.js";

// The savings blueprint is standalone (own Aiken project, onchain/savings) —
// it never rides on the DCU or escrow deployments, so savings work can't
// ripple their hashes.
const validators = Effect.runSync(
  readValidators(blueprint as unknown as Blueprint),
);

const raw = (title: string): Script =>
  Effect.runSync(getScript(validators, title));

// ─── ADR-0003: one thin dispatcher, two withdraw-zero families ──────────────
// The vault script mints the fund/account/loan tokens and guards the vault
// address, but validates nothing heavy: every spend proves that its family's
// 0-ADA withdrawal covers the UTxO, and every mint proves the licensing family
// transition runs in the same transaction. The families carry the logic.
//
// Both family validators are unparameterized, so their hashes are compile-time
// constants; the vault takes them as parameters. Bootstrapping runs in that
// direction only, so there is no circular dependency between the three hashes.

/** `savings_governed` — SocialPayout, UpdateFund, CloseCycle, DisburseLoan,
 *  WriteOffLoan, CloseFund. The ADR-0002 intent-bound set. */
export const savingsGovernedValidator = raw(
  "savings_governed.savings_governed.withdraw",
);

/** `savings_direct` — Deposit, Withdraw, ClaimShareOut, RepayLoan, MarkArrears,
 *  RemoveAccount. Directly authorized, still fully checked. */
export const savingsDirectValidator = raw(
  "savings_direct.savings_direct.withdraw",
);

export const savingsGovernedHash = validatorToScriptHash(
  savingsGovernedValidator,
);
export const savingsDirectHash = validatorToScriptHash(savingsDirectValidator);

const withFamilyParams = (title: string): Script => ({
  type: "PlutusV3",
  script: applyParamsToScript(raw(title).script, [
    savingsGovernedHash,
    savingsDirectHash,
  ]),
});

/** The thin dispatcher: the savings policy and vault address of the module. */
export const savingsVaultValidator = {
  spendVault: withFamilyParams("savings_vault_validator.savings_vault.spend"),
  mintVault: withFamilyParams("savings_vault_validator.savings_vault.mint"),
};

export const savingsPolicyId = mintingPolicyToId(
  savingsVaultValidator.mintVault,
);

/** The savings families, keyed the way endpoints select one. */
export type SavingsFamily = "governed" | "direct";

export const savingsFamilyValidator: Readonly<Record<SavingsFamily, Script>> = {
  governed: savingsGovernedValidator,
  direct: savingsDirectValidator,
};

/**
 * Reward (stake) address of a savings family stake validator. Both credentials
 * must be registered once per deployment before any savings operation can run.
 */
export const savingsFamilyRewardAddress = (
  network: Network,
  family: SavingsFamily,
): string => validatorToRewardAddress(network, savingsFamilyValidator[family]);
