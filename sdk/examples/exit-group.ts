/**
 * Exit Group Example
 *
 * Exits a member from a ROSCA group.
 *   - Early exit (before maturity): moves treasury to PenaltyState (locked for admin).
 *   - Mature exit (after all intervals): burns membership token and refunds balance.
 *
 * Reads groupTokenSuffix and accountTokenSuffix from state.json.
 * Run create-group.ts, create-account.ts, and join-group.ts first.
 */

import { exitGroup, ExitGroupConfig } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl, logError } from "./context.js";
import { loadState } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires an active group membership.");
        console.log("See rosca-lifecycle.ts for a full emulator demonstration.");
        process.exit(0);
    }

    const { groupTokenSuffix, accountTokenSuffix } = loadState();
    if (!groupTokenSuffix)   throw new Error("groupTokenSuffix not found in state.json. Run create-group.ts first.");
    if (!accountTokenSuffix) throw new Error("accountTokenSuffix not found in state.json. Run join-group.ts first.");

    const config: ExitGroupConfig = {
        groupTokenSuffix,
        accountTokenSuffix,
    };

    console.log("Building exit transaction...");
    const tx = await exitGroup(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log("Exited group successfully!");
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
