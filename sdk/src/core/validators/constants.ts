import {
  mintingPolicyToId,
} from "@lucid-evolution/lucid";
import { PlutusArtifact } from "../loader.js";
import { readValidators, getScript } from "./reader.js";
import { Effect } from "effect";

// Load all validators from blueprint synchronously (safe as it's static JSON)
const validators = Effect.runSync(readValidators(PlutusArtifact));

// Helper to access safe script
const getValidator = (title: string) => {
    return Effect.runSync(getScript(validators, title));
}

// --- Account ---
export const accountValidator = {
    spendAccount: getValidator("account_validator.account.spend"),
    mintAccount: getValidator("account_validator.account.mint"),
};

export const accountPolicyId = mintingPolicyToId(accountValidator.mintAccount);

export const accountScript = {
    spending: accountValidator.spendAccount.script,
    minting: accountValidator.mintAccount.script,
};

// --- Group ---
export const groupValidator = {
    spendGroup: getValidator("group_validator.group.spend"),
    mintGroup: getValidator("group_validator.group.mint"),
};

export const groupPolicyId = mintingPolicyToId(groupValidator.mintGroup);

export const groupScript = {
    spending: groupValidator.spendGroup.script,
    minting: groupValidator.mintGroup.script,
};

// --- Treasury ---
export const treasuryValidator = {
    spendTreasury: getValidator("treasury_validator.treasury.spend"),
    mintTreasury: getValidator("treasury_validator.treasury.mint"),
};

export const treasuryPolicyId = mintingPolicyToId(treasuryValidator.mintTreasury);

export const treasuryScript = {
    spending: treasuryValidator.spendTreasury.script,
    minting: treasuryValidator.mintTreasury.script,
};
