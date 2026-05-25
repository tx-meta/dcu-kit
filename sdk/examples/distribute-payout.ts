/**
 * Distribute Payout Example
 *
 * Aggregates claimable contributions from all treasury UTxOs and pays them
 * out to the member assigned to the current rotation slot (the borrower).
 * This transaction is PERMISSIONLESS — any wallet can trigger it. The payout
 * always goes to the borrower's address stored in the datum, not the caller's.
 *
 * Wallet selection:
 *   Default (ADMIN): uses ADMIN_SEED — most likely to have a pure ADA UTxO for collateral.
 *   ACTIVE_WALLET=USER1: uses USER1_SEED
 *   ACTIVE_WALLET=USER2: uses USER2_SEED
 *
 * If you see a collateral error, the selected wallet has no pure ADA UTxO.
 * Fix: send 5 ADA to that wallet first:
 *   AMOUNT=5000000 FROM_WALLET=ADMIN TO_WALLET=USER1 pnpm run send-ada
 *
 * Reads groupTokenSuffix from state.json. Run create-group.ts and join-group.ts first.
 */

import { distributePayout, DistributePayoutConfig, accountPolicyId, groupPolicyId } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl, logError, logWalletInfo } from "./context.js";
import { loadState, printSlotSchedule, computeSlotInfo, checkValidatorStaleness } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires an active group with treasury UTxOs.");
        console.log("See rosca-lifecycle.ts for a full emulator demonstration.");
        process.exit(0);
    }

    // distribute-payout is permissionless — any wallet can submit it.
    // Default to ADMIN since it's most likely to have a pure ADA UTxO for collateral.
    const activeWallet = (process.env.ACTIVE_WALLET ?? "ADMIN").toUpperCase();
    const walletSeed   = process.env[`${activeWallet}_SEED`] ?? process.env.ADMIN_SEED;
    if (!walletSeed) throw new Error(`${activeWallet}_SEED not found in .env`);
    lucid.selectWallet.fromSeed(walletSeed);
    await logWalletInfo(lucid, activeWallet);
    console.log(`Submitting as: ${activeWallet} (payout goes to the current slot holder regardless)`);

    checkValidatorStaleness({ accountPolicyId, groupPolicyId: groupPolicyId! });

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
