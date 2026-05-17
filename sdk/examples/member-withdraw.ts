/**
 * Member Withdraw Example
 *
 * Withdraws a specified amount from the member's treasury UTxO.
 * The remaining balance stays locked in the treasury.
 *
 * Reads groupTokenSuffix and accountTokenSuffix from state.json.
 * Run create-group.ts, create-account.ts, and join-group.ts first.
 */

import { memberWithdraw, MemberWithdrawConfig } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl, logError } from "./context.js";
import { loadState } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires an active group membership with treasury funds.");
        console.log("See rosca-lifecycle.ts for a full emulator demonstration.");
        process.exit(0);
    }

    const { groupTokenSuffix, accountTokenSuffix } = loadState();
    if (!groupTokenSuffix)   throw new Error("groupTokenSuffix not found in state.json. Run create-group.ts first.");
    if (!accountTokenSuffix) throw new Error("accountTokenSuffix not found in state.json. Run join-group.ts first.");

    const WITHDRAW_AMOUNT = 2_000_000n; // 2 ADA — adjust as needed

    const config: MemberWithdrawConfig = {
        groupTokenSuffix,
        accountTokenSuffix,
        withdrawAmount: WITHDRAW_AMOUNT,
    };

    console.log(`Withdrawing ${WITHDRAW_AMOUNT / 1_000_000n} ADA from treasury...`);
    const tx = await memberWithdraw(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log("Withdrawal successful!");
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
