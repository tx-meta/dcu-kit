/**
 * Distribute Payout Example
 *
 * Aggregates claimable contributions from all treasury UTxOs and pays them
 * out to the member assigned to the current rotation slot (the borrower).
 * Any wallet can trigger this — the payout goes to the slot holder regardless.
 *
 * Reads groupTokenSuffix from state.json. Run create-group.ts and join-group.ts first.
 */

import { distributePayout, DistributePayoutConfig } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl, logError } from "./context.js";
import { loadState, printSlotSchedule, computeSlotInfo } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires an active group with treasury UTxOs.");
        console.log("See rosca-lifecycle.ts for a full emulator demonstration.");
        process.exit(0);
    }

    const state = loadState();
    const { groupTokenSuffix } = state;
    if (!groupTokenSuffix) throw new Error("groupTokenSuffix not found in state.json. Run create-group.ts first.");

    // Show current slot before attempting the tx — tells you immediately
    // whether the slot window is open or how long to wait.
    const slotInfo = computeSlotInfo(state);
    if (slotInfo) {
        const secsLeft = Math.ceil(slotInfo.msUntilNextSlot / 1000);
        console.log(`Current slot: ${slotInfo.currentSlot}  (next slot in ${secsLeft}s)`);
    }
    printSlotSchedule(state, [0, 1]); // adjust member slots as needed

    const config: DistributePayoutConfig = {
        groupTokenSuffix,
    };

    console.log("Building payout transaction...");
    const tx = await distributePayout(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log("Payout distributed successfully!");
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
