import { mintingPolicyToId, Script } from "@lucid-evolution/lucid";
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

// One multi-purpose validator: the same script hash mints the fund/account
// tokens and guards the vault address (self-coupled, spec 3.3).
export const savingsVaultValidator = {
  spendVault: raw("savings_vault_validator.savings_vault.spend"),
  mintVault: raw("savings_vault_validator.savings_vault.mint"),
};

export const savingsPolicyId = mintingPolicyToId(
  savingsVaultValidator.mintVault,
);
