import {
  mintingPolicyToId,
  applyParamsToScript,
  Script,
} from "@lucid-evolution/lucid";
import blueprint from "../plutus.json" with { type: "json" };
import { readValidators, getScript, Blueprint } from "./reader.js";
import { Effect } from "effect";

// Load all validators from blueprint synchronously (safe as it's static JSON)
const validators = Effect.runSync(
  readValidators(blueprint as unknown as Blueprint),
);

const raw = (title: string): Script =>
  Effect.runSync(getScript(validators, title));

// Data.to(hexString) in Lucid Evolution treats a plain string as raw bytes (ByteArray).
// applyParamsToScript internally calls Data.to on each param, so a raw policyId hex
// string is correctly applied as a Plutus ByteArray — no manual CBOR prefix needed.
// This matches the payment-subscription pattern: applyParamsToScript(script, [policyId]).
const withPolicyParam = (script: Script, policyId: string): Script => ({
  type: "PlutusV3",
  script: applyParamsToScript(script.script, [policyId]),
});

// --- Account (no parameters) ---
export const accountValidator = {
  spendAccount: raw("account_validator.account.spend"),
  mintAccount: raw("account_validator.account.mint"),
};
export const accountPolicyId = mintingPolicyToId(accountValidator.mintAccount);
export const accountScript = {
  spending: accountValidator.spendAccount.script,
  minting: accountValidator.mintAccount.script,
};

// --- Treasury (parameterized with accountPolicyId) ---
// Must be computed before group so groupValidator can reference treasuryPolicyId.
export const treasuryValidator = {
  spendTreasury: withPolicyParam(
    raw("treasury_validator.treasury.spend"),
    accountPolicyId,
  ),
  mintTreasury: withPolicyParam(
    raw("treasury_validator.treasury.mint"),
    accountPolicyId,
  ),
};
export const treasuryPolicyId = mintingPolicyToId(
  treasuryValidator.mintTreasury,
);
export const treasuryScript = {
  spending: treasuryValidator.spendTreasury.script,
  minting: treasuryValidator.mintTreasury.script,
};

// --- Group (parameterized with treasuryPolicyId) ---
export const groupValidator = {
  spendGroup: withPolicyParam(
    raw("group_validator.group_validator.spend"),
    treasuryPolicyId,
  ),
  mintGroup: withPolicyParam(
    raw("group_validator.group_validator.mint"),
    treasuryPolicyId,
  ),
};
export const groupPolicyId = mintingPolicyToId(groupValidator.mintGroup);
export const groupScript = {
  spending: groupValidator.spendGroup.script,
  minting: groupValidator.mintGroup.script,
};

// --- AlwaysFails (no parameters) ---
// Used as the deployment address for reference scripts. UTxOs sent here can
// never be spent, so reference scripts remain permanently available on-chain.
export const alwaysFailsValidator = {
  elseAlwaysFails: raw("always_fails.always_fails.else"),
};
