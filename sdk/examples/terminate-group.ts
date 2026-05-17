/**
 * Terminate Group Example
 *
 * Admin claims a PenaltyState treasury UTxO left by a member who exited early.
 * Burns the membership token and releases the locked ADA to the admin wallet.
 *
 * Reads groupTokenSuffix and accountTokenSuffix from state.json.
 * Requires a PenaltyState treasury UTxO to exist — run exit-group.ts (early exit) first.
 */

import { terminateGroup, TerminateGroupConfig } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl, logError } from "./context.js";
import { loadState } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires a PenaltyState treasury UTxO (created by an early exit).");
        console.log("See rosca-lifecycle.ts for a full emulator demonstration.");
        process.exit(0);
    }

    const adminSeed = process.env.ADMIN_SEED ?? process.env.USER1_SEED;
    if (!adminSeed) throw new Error("ADMIN_SEED or USER1_SEED is required.");
    lucid.selectWallet.fromSeed(adminSeed);

    const { groupTokenSuffix, accountTokenSuffix } = loadState();
    if (!groupTokenSuffix)   throw new Error("groupTokenSuffix not found in state.json. Run create-group.ts first.");
    if (!accountTokenSuffix) throw new Error("accountTokenSuffix not found in state.json. Run join-group.ts first.");

    // memberAccountTokenSuffix is the exited member's account token suffix.
    // In a single-member lifecycle this is the same as accountTokenSuffix.
    const config: TerminateGroupConfig = {
        groupTokenSuffix,
        memberAccountTokenSuffix: accountTokenSuffix,
    };

    console.log("Building terminate transaction...");
    const tx = await terminateGroup(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log("Penalty withdrawn successfully!");
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
