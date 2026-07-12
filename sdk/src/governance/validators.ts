import {
  applyParamsToScript,
  Constr,
  fromText,
  mintingPolicyToId,
  Script,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import blueprint from "./plutus.json" with { type: "json" };
import {
  Blueprint,
  getScript,
  readValidators,
} from "../core/validators/reader.js";

// The governance blueprint is standalone (own Aiken project, onchain/governance)
// — four scripts wired by a per-instance parameter chain, never touching the
// rosca / escrow / savings deployments.
const validators = Effect.runSync(
  readValidators(blueprint as unknown as Blueprint),
);

const raw = (title: string): Script =>
  Effect.runSync(getScript(validators, title));

// Data.to(hexString) treats a plain hex string as raw bytes (ByteArray), so a
// policyId is applied as a Plutus ByteArray (the payment-subscription pattern).
const withPolicyParam = (script: Script, policyId: string): Script => ({
  type: "PlutusV3",
  script: applyParamsToScript(script.script, [policyId]),
});

/** Fixed anchor token name; the settings policy's seed makes the instance
 *  unique, so a constant name is enough. Must match the Aiken validator. */
export const ANCHOR_TOKEN_NAME = fromText("anchor");

export interface GovernanceInstance {
  seed: { txHash: string; outputIndex: number };
  /** Per-instance one-shot settings policy id. */
  settingsPolicy: string;
  /** The settings minting policy (mints the anchor NFT). */
  settingsValidator: Script;
  /** Unit (policyId + assetName) of this instance's anchor NFT. */
  anchorUnit: string;
  /** Dispatcher mint + spend share one hash — the instance identity (govPolicy). */
  dispatcherValidator: { mint: Script; spend: Script };
  govPolicy: string;
  /** Withdraw-zero voting validator carrying all heavy logic. */
  votingValidator: Script;
  votingStakeHash: string;
  /** The composition seam; a vault's quorum Credential is Script(gateHash). */
  gateValidator: Script;
  gateHash: string;
}

/**
 * Derive the full validator set for one governance instance from its seed UTxO.
 *
 * The seed makes the settings policy — and therefore every downstream hash —
 * unique, so a vault's quorum can commit to exactly one instance's gate. Chain:
 * seed → settingsPolicy → dispatcher(settingsPolicy)=govPolicy → gate(govPolicy);
 * voting(settingsPolicy) is the withdraw-zero stake validator.
 */
export const buildGovernance = (seed: {
  txHash: string;
  outputIndex: number;
}): GovernanceInstance => {
  // Aiken OutputReference = Constr(0, [transaction_id: ByteArray, output_index: Int]).
  const seedData = new Constr(0, [seed.txHash, BigInt(seed.outputIndex)]);
  const settingsValidator: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(
      raw("governance_settings.governance_settings.mint").script,
      [seedData],
    ),
  };
  const settingsPolicy = mintingPolicyToId(settingsValidator);

  const dispatcherValidator = {
    mint: withPolicyParam(
      raw("governance_dispatcher.governance_dispatcher.mint"),
      settingsPolicy,
    ),
    spend: withPolicyParam(
      raw("governance_dispatcher.governance_dispatcher.spend"),
      settingsPolicy,
    ),
  };
  const govPolicy = mintingPolicyToId(dispatcherValidator.mint);

  const votingValidator = withPolicyParam(
    raw("governance_voting.governance_voting.withdraw"),
    settingsPolicy,
  );
  const votingStakeHash = validatorToScriptHash(votingValidator);

  const gateValidator = withPolicyParam(
    raw("governance_gate.governance_gate.spend"),
    govPolicy,
  );
  const gateHash = validatorToScriptHash(gateValidator);

  return {
    seed,
    settingsPolicy,
    settingsValidator,
    anchorUnit: settingsPolicy + ANCHOR_TOKEN_NAME,
    dispatcherValidator,
    govPolicy,
    votingValidator,
    votingStakeHash,
    gateValidator,
    gateHash,
  };
};
