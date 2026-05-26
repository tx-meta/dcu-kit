/**
 * Deploy Reference Scripts
 *
 * Deploys the treasury and group validators as permanent reference-script UTxOs
 * at the alwaysFails address. Once deployed, all subsequent transactions
 * (joinGroup, exitGroup, etc.) can reference these UTxOs instead of including
 * the full script bytes inline, keeping every transaction under Cardano's 16KB
 * limit.
 *
 * Why alwaysFails?
 *   The alwaysFails validator can never succeed, so UTxOs at that address are
 *   permanently locked. Reference scripts deposited here stay on-chain forever
 *   and cannot be accidentally spent or stolen.
 *
 * Why two transactions?
 *   Each validator is ~8 KB. Combining both in one transaction (~16 KB of scripts
 *   plus the tx envelope) exceeds Cardano's 16,384-byte limit. One per tx is safe.
 *
 * Run this ONCE per validator set. The outRefs are saved to state.json and
 * loaded automatically by join-group.ts and exit-group.ts.
 *
 * Cost: ~56 ADA total (30 ADA treasury + 26 ADA group) — permanently locked.
 *
 * Usage:
 *   pnpm run deploy-scripts
 */

import { Effect } from "effect";
import { deployScripts, verifyDeployment } from "@tx-meta/dcu-sdk";
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
    console.log("deploy-scripts is for live networks only.");
    process.exit(0);
  }

  const adminSeed = process.env.ADMIN_SEED ?? process.env.USER1_SEED;
  if (!adminSeed) throw new Error("ADMIN_SEED not found in .env");
  lucid.selectWallet.fromSeed(adminSeed);
  await logWalletInfo(lucid, "ADMIN");

  const state = loadState();

  // If already deployed, verify both UTxOs are still on-chain.
  if (state.scriptRefTreasury && state.scriptRefGroup) {
    const result = await Effect.runPromise(
      verifyDeployment(lucid, {
        treasuryRef: state.scriptRefTreasury,
        groupRef: state.scriptRefGroup,
      }),
    );

    if (result.ok) {
      console.log("Reference scripts already deployed and verified on-chain.");
      console.log(
        "  treasury:",
        state.scriptRefTreasury.txHash.slice(0, 16) +
          "..." +
          `#${state.scriptRefTreasury.outputIndex}`,
      );
      console.log(
        "  group:   ",
        state.scriptRefGroup.txHash.slice(0, 16) +
          "..." +
          `#${state.scriptRefGroup.outputIndex}`,
      );
      console.log("  address: ", result.treasuryUtxo?.address);
      return;
    }

    console.warn("Stored refs have issues — redeploying...");
    for (const issue of result.issues) console.warn(" ", issue);
  }

  console.log("Deploying treasury validator (tx 1/2)...");
  console.log(
    "Deploying group validator (tx 2/2, submitted after tx 1 confirms)...",
  );
  console.log(
    "Destination: alwaysFails address (scripts are permanently locked).",
  );
  console.log(
    "This will take ~2 minutes (one on-chain confirmation between txs).\n",
  );

  const deployResult = await Effect.runPromise(deployScripts(lucid));

  console.log("\nBoth transactions confirmed.");
  console.log(
    "  treasury tx:",
    cexplorerTxUrl(deployResult.treasuryRef.txHash),
  );
  console.log("  group tx:   ", cexplorerTxUrl(deployResult.groupRef.txHash));
  console.log("  address:    ", deployResult.deployAddress);

  saveState({
    scriptRefTreasury: deployResult.treasuryRef,
    scriptRefGroup: deployResult.groupRef,
  });

  console.log("\nReference scripts saved to state.json.");
  console.log("join-group and exit-group will now use these automatically.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
