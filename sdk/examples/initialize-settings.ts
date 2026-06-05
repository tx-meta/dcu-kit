/**
 * Initialize Protocol Settings (P5) — ONE-TIME deploy step.
 *
 * Mints the singleton settings NFT and locks a ProtocolSettings datum (recording
 * the account / group / treasury policy IDs) in an immutable UTxO at the always-fails
 * address. Every later treasury transaction references this UTxO to authenticate the
 * trusted group policy — this is the root fix for the C1/C2/C3 binding vulnerabilities.
 *
 * Must be run ONCE on a fresh deployment, before deploy-scripts and any group/treasury
 * operation. The resulting settings policy is saved to state.json and consumed by every
 * other example via loadSdk().
 *
 * Live network only (requires BLOCKFROST_KEY or MAESTRO_API_KEY + ADMIN_SEED in .env).
 */

import { initializeSettings, deriveSettings } from "@tx-meta/dcu-sdk";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  logWalletInfo,
} from "./context.js";
import { loadState, saveState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log("initialize-settings is for live networks only.");
    process.exit(0);
  }

  const adminSeed = process.env.ADMIN_SEED ?? process.env.USER1_SEED;
  if (!adminSeed) throw new Error("ADMIN_SEED not found in .env");
  lucid.selectWallet.fromSeed(adminSeed);
  await logWalletInfo(lucid, "ADMIN");

  // Idempotency: if settings already exist on-chain, do nothing.
  const existing = loadState();
  if (existing.settingsPolicy) {
    console.log("Protocol settings already initialized.");
    console.log("  settingsPolicy:", existing.settingsPolicy);
    console.log(
      "Delete it from state.json only if redeploying a fresh protocol.",
    );
    return;
  }

  // Pick the seed UTxO explicitly so we can derive the resulting policy up front and
  // submit the SAME seed — keeping the recorded policy deterministic.
  const walletUtxos = await lucid.wallet().getUtxos();
  if (walletUtxos.length === 0)
    throw new Error("No UTxOs found. Please fund the admin wallet first.");
  const seed = walletUtxos[0];

  const derived = deriveSettings({
    txHash: seed.txHash,
    outputIndex: seed.outputIndex,
  });
  console.log("Settings policy (derived):", derived.settingsPolicy);
  console.log("  account policy: ", derived.accountPolicy);
  console.log("  group policy:   ", derived.groupPolicy);
  console.log("  treasury policy:", derived.treasuryPolicy);

  console.log("\nBuilding initialize-settings transaction...");
  const tx = await initializeSettings(lucid, seed).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  saveState({
    settingsPolicy: derived.settingsPolicy,
    settingsSeed: { txHash: seed.txHash, outputIndex: seed.outputIndex },
  });

  console.log("\nProtocol settings initialized.");
  console.log("Next: pnpm run deploy-scripts");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
