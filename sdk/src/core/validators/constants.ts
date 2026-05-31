import {
  mintingPolicyToId,
  applyParamsToScript,
  Constr,
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

// ─── P5: Protocol Settings factory ──────────────────────────────────────────
// settings_policy is deploy-time (a one-shot NFT seeded by a chosen UTxO), so the
// treasury/group validators can no longer be static module constants. buildProtocol
// derives them from a known settings_policy. The static exports above remain for
// account (a root, settings-independent); endpoints migrate to buildProtocol (Slice 4b).

// Asset name of the singleton settings NFT — "settings" in UTF-8 (matches Aiken).
export const settingsTokenName = "73657474696e6773";

// Build the one-shot settings-NFT minting policy from a seed UTxO. Used once at deploy
// time (initializeSettings) to mint the singleton settings NFT.
export const buildSettingsNft = (seed: {
  txHash: string;
  outputIndex: number;
}): { validator: Script; policyId: string } => {
  // Aiken OutputReference = Constr(0, [transaction_id: ByteArray, output_index: Int]).
  const seedData = new Constr(0, [seed.txHash, BigInt(seed.outputIndex)]);
  const validator: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(raw("settings_validator.settings_nft.mint").script, [
      seedData,
    ]),
  };
  return { validator, policyId: mintingPolicyToId(validator) };
};

export interface Protocol {
  settingsPolicy: string;
  // unit (policyId + assetName) of the singleton settings NFT to .readFrom() / locate.
  settingsUnit: string;
  accountValidator: typeof accountValidator;
  accountPolicyId: string;
  treasuryValidator: { spendTreasury: Script; mintTreasury: Script };
  treasuryPolicyId: string;
  treasuryScript: { spending: string; minting: string };
  groupValidator: { spendGroup: Script; mintGroup: Script };
  groupPolicyId: string;
  groupScript: { spending: string; minting: string };
  alwaysFailsValidator: typeof alwaysFailsValidator;
}

// Derive the full set of validators/policies for a deployment from its settings_policy.
// treasury is parameterized by settings_policy; group by the resulting treasuryPolicyId;
// account is the settings-independent root.
export const buildProtocol = (settingsPolicy: string): Protocol => {
  const treasury = {
    spendTreasury: withPolicyParam(
      raw("treasury_validator.treasury.spend"),
      settingsPolicy,
    ),
    mintTreasury: withPolicyParam(
      raw("treasury_validator.treasury.mint"),
      settingsPolicy,
    ),
  };
  const tPolicy = mintingPolicyToId(treasury.mintTreasury);
  const group = {
    spendGroup: withPolicyParam(
      raw("group_validator.group_validator.spend"),
      tPolicy,
    ),
    mintGroup: withPolicyParam(
      raw("group_validator.group_validator.mint"),
      tPolicy,
    ),
  };
  const gPolicy = mintingPolicyToId(group.mintGroup);
  return {
    settingsPolicy,
    settingsUnit: settingsPolicy + settingsTokenName,
    accountValidator,
    accountPolicyId,
    treasuryValidator: treasury,
    treasuryPolicyId: tPolicy,
    treasuryScript: {
      spending: treasury.spendTreasury.script,
      minting: treasury.mintTreasury.script,
    },
    groupValidator: group,
    groupPolicyId: gPolicy,
    groupScript: {
      spending: group.spendGroup.script,
      minting: group.mintGroup.script,
    },
    alwaysFailsValidator,
  };
};
