/**
 * Resume governance-init after it was interrupted.
 *
 * The anchor is minted and the voting stake is registered; only the two
 * reference-script deploys (governance-init.ts:126-157) are missing. Re-running
 * governance-init would mint a NEW instance under a new seed, so this replays
 * just the deploy loop against the seed already in state.json.
 *
 * Scans the wallet for an already-deployed ref script first — the interrupted
 * run may have submitted one without recording it.
 */
import { validatorToScriptHash } from "@lucid-evolution/lucid";
import { buildGovernance } from "@tx-meta/dcu-kit/governance";
import { makeLucid, cexplorerTxUrl, selectEnvWallet } from "./dist/context.js";
import { loadState, saveState } from "./dist/state.js";

const { lucid } = await makeLucid();
await selectEnvWallet(lucid, "USER1");
const address = await lucid.wallet().address();

const state = loadState();
const gov = buildGovernance(state.governanceSeed);

const targets = [
  ["scriptRefGovernanceDispatcher", gov.dispatcherValidator.spend],
  ["scriptRefGovernanceVoting", gov.votingValidator],
];

// An interrupted run may have deployed without saving — reclaim it if so.
const utxos = await lucid.wallet().getUtxos();
const onChain = new Map();
for (const u of utxos) {
  if (u.scriptRef) onChain.set(validatorToScriptHash(u.scriptRef), u);
}

const settle = () => new Promise((r) => setTimeout(r, 60_000));
let first = true;

for (const [key, script] of targets) {
  const hash = validatorToScriptHash(script);
  if (state[key]) {
    console.log(`${key}: already recorded — skipping.`);
    continue;
  }
  const existing = onChain.get(hash);
  if (existing) {
    console.log(
      `${key}: found undeclared on-chain ref ${existing.txHash}#${existing.outputIndex} — recording, not redeploying.`,
    );
    saveState({ [key]: { txHash: existing.txHash, outputIndex: existing.outputIndex } });
    continue;
  }

  if (!first) {
    console.log("Waiting 60s for Blockfrost indexing...");
    await settle();
  }
  first = false;

  console.log(`\nDeploying ${key} (hash ${hash})...`);
  const tx = await lucid
    .newTx()
    .pay.ToAddressWithData(
      address,
      undefined,
      { lovelace: 20_000_000n },
      { type: "PlutusV3", script: script.script },
    )
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Submitted. Hash:", txHash);
  console.log("View:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);
  saveState({ [key]: { txHash, outputIndex: 0 } });
  console.log(`${key} recorded.`);
}

console.log("\nGovernance reference scripts complete.");
