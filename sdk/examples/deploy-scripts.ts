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
 * Why one script per transaction?
 *   A deploy tx must carry the full script; batching risks the 16,384-byte tx
 *   limit. The treasury split (2026-07-04) publishes SIX ref scripts — the
 *   treasury dispatcher, the group validator, and the four withdraw-zero family
 *   stake validators (rounds/lifecycle/recovery/reserve) — one per tx. A final
 *   step registers the four family stake credentials — the withdraw-zero
 *   prerequisite without which no treasury operation can run. Registration is
 *   idempotent: re-runs treat "already registered" as success.
 *
 * Run this ONCE per validator set. The outRefs are saved to state.json and
 * loaded automatically by every treasury endpoint example.
 *
 * Cost: ~six ref-script deposits (scale with script size) + 4×2 ADA stake
 * deposits, all permanently locked / reclaimable respectively.
 *
 * Usage:
 *   pnpm run deploy-scripts
 */

import { Effect } from "effect";
import {
  deployScripts,
  registerTreasuryStake,
  verifyDeployment,
} from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
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

  const { protocol } = loadSdk();
  const state = loadState();

  // If already deployed, verify both UTxOs are still on-chain.
  if (state.scriptRefTreasury && state.scriptRefGroup) {
    const result = await Effect.runPromise(
      verifyDeployment(protocol, lucid, {
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

      // The refs being on-chain does not prove the stake registrations ran — an
      // interrupted deploy can leave a family credential unregistered, and every
      // treasury operation would fail. Idempotent, so always safe to ensure here.
      const stakeReg = await Effect.runPromise(
        registerTreasuryStake(protocol, lucid),
      );
      for (const reg of stakeReg.registrations) {
        console.log(
          reg.alreadyRegistered
            ? `  stake:    ${reg.family} credential already registered.`
            : `  stake:    ${reg.family} credential registered now (${cexplorerTxUrl(reg.txHash!)})`,
        );
      }
      return;
    }

    console.warn("Stored refs have issues — redeploying...");
    for (const issue of result.issues) console.warn(" ", issue);
  }

  console.log(
    "Deploying six reference scripts (treasury dispatcher, group, and the four",
  );
  console.log(
    "family stake validators), one per tx, then registering the four family",
  );
  console.log("stake credentials (withdraw-zero prerequisite).");
  console.log(
    "Destination: alwaysFails address (scripts are permanently locked).",
  );
  console.log(
    "This will take a few minutes (one on-chain confirmation between txs).\n",
  );

  const deployResult = await Effect.runPromise(deployScripts(protocol, lucid));

  console.log("\nAll reference scripts confirmed.");
  console.log("  treasury tx:", cexplorerTxUrl(deployResult.refs.treasury.txHash));
  console.log("  group tx:   ", cexplorerTxUrl(deployResult.refs.group.txHash));
  console.log("  address:    ", deployResult.deployAddress);
  for (const reg of deployResult.stakeRegistrations.registrations) {
    console.log(
      `  stake:       ${reg.family} → ${reg.rewardAddress}${reg.alreadyRegistered ? " (already registered)" : ""}`,
    );
  }

  saveState({
    scriptRefTreasury: deployResult.refs.treasury,
    scriptRefGroup: deployResult.refs.group,
    scriptRefTreasuryRounds: deployResult.refs.treasuryRounds,
    scriptRefTreasuryLifecycle: deployResult.refs.treasuryLifecycle,
    scriptRefTreasuryRecovery: deployResult.refs.treasuryRecovery,
    scriptRefTreasuryReserve: deployResult.refs.treasuryReserve,
  });

  console.log("\nReference scripts saved to state.json.");
  console.log("Every treasury endpoint example will now use these automatically.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
