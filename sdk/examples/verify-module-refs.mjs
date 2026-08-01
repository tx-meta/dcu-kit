/**
 * Verify module reference scripts recorded in state.json are on-chain, carry a
 * scriptRef, and match the hash the SDK derives locally. Covers what
 * verify-protocol-deployment.ts does not: savings, escrow v2, governance.
 */
import { readFileSync } from "node:fs";
import { validatorToScriptHash } from "@lucid-evolution/lucid";
import { savingsVaultValidator } from "@tx-meta/dcu-kit/savings";
import { escrowV2Validator } from "@tx-meta/dcu-kit/escrow/v2";
import { buildGovernance } from "@tx-meta/dcu-kit/governance";
import { makeLucid } from "./dist/context.js";

const state = JSON.parse(readFileSync("./state.json", "utf8"));
const { lucid } = await makeLucid();

const expected = [
  ["scriptRefSavings", savingsVaultValidator.spendVault],
  ["scriptRefEscrowV2", escrowV2Validator.spendEscrow],
];

if (state.governanceSeed) {
  const gov = buildGovernance(state.governanceSeed);
  console.log("governance instance derived from saved seed:");
  console.log("  settingsPolicy:", gov.settingsPolicy);
  console.log("  govPolicy     :", gov.govPolicy);
  console.log("  votingStake   :", gov.votingStakeHash);
  console.log("  gateHash      :", gov.gateHash);
  expected.push(
    ["scriptRefGovernanceDispatcher", gov.dispatcherValidator.spend],
    ["scriptRefGovernanceVoting", gov.votingValidator],
  );
}

let allOk = true;
for (const [key, script] of expected) {
  const ref = state[key];
  const expectedHash = validatorToScriptHash(script);
  if (!ref) {
    console.log(`✗ ${key}: NOT in state.json (expected hash ${expectedHash})`);
    allOk = false;
    continue;
  }
  const [utxo] = await lucid.utxosByOutRef([ref]);
  const onChainHash = utxo?.scriptRef
    ? validatorToScriptHash(utxo.scriptRef)
    : null;
  const ok = onChainHash === expectedHash;
  if (!ok) allOk = false;
  console.log(
    `${ok ? "✓" : "✗"} ${key}: ${ref.txHash.slice(0, 8)}…#${ref.outputIndex} ` +
      `onchain=${onChainHash?.slice(0, 12) ?? "NONE"} expected=${expectedHash.slice(0, 12)}`,
  );
}

console.log(allOk ? "\nAll module refs verified." : "\nGAPS REMAIN (see ✗).");
