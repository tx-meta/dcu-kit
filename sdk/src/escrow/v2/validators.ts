import { mintingPolicyToId, Script } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import blueprint from "../plutus.json" with { type: "json" };
import {
  Blueprint,
  getScript,
  readValidators,
} from "../../core/validators/reader.js";

// Same standalone escrow blueprint as v1 — one file carries all generations.
// v1 (escrow_validator) is untouched; v2 + project are additions, so live v1
// escrows and their integrators are never locked out.
const validators = Effect.runSync(
  readValidators(blueprint as unknown as Blueprint),
);

const raw = (title: string): Script =>
  Effect.runSync(getScript(validators, title));

export const escrowV2Validator = {
  spendEscrow: raw("escrow_v2_validator.escrow_v2_validator.spend"),
  mintEscrow: raw("escrow_v2_validator.escrow_v2_validator.mint"),
};

export const escrowV2PolicyId = mintingPolicyToId(escrowV2Validator.mintEscrow);

export const projectValidator = {
  spendProject: raw("project_validator.project_validator.spend"),
  mintProject: raw("project_validator.project_validator.mint"),
};

export const projectPolicyId = mintingPolicyToId(projectValidator.mintProject);

export const poolVaultValidator = {
  spendPool: raw("pool_vault_validator.pool_vault.spend"),
  mintPool: raw("pool_vault_validator.pool_vault.mint"),
};

export const poolPolicyId = mintingPolicyToId(poolVaultValidator.mintPool);
