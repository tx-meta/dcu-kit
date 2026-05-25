/**
 * Defer Round Example
 *
 * Sets is_deferred=true on a member's treasury UTxO, signalling that the member
 * wishes to skip their assigned payout slot in the next distribute-payout call.
 * The distributeRound validator skips deferred members and pays the next eligible
 * slot holder. The flag is automatically reset to false after the round is processed.
 *
 * Use case: a member knows they will not need the payout this cycle and voluntarily
 * gives up their turn so someone else can receive it sooner.
 *
 * Guard: fails if is_deferred is already true (idempotent protection on-chain).
 *
 * Wallet selection:
 *   Default (USER1): uses USER1_SEED
 *   ACTIVE_WALLET=USER2: uses USER2_SEED
 *   ACTIVE_WALLET=ADMIN: uses ADMIN_SEED
 *
 * Reads accountTokenSuffix from state.json (keyed by active wallet).
 */

import { deferRound, DeferRoundConfig, accountPolicyId, groupPolicyId } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl, logError, logWalletInfo } from "./context.js";
import { loadState, checkValidatorStaleness, accountSuffixKey } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires an active treasury membership.");
        console.log("These example scripts require existing on-chain state. Run on Preprod.");
        process.exit(0);
    }

    const activeWallet = (process.env.ACTIVE_WALLET ?? "USER1").toUpperCase();
    const walletSeed   = process.env[`${activeWallet}_SEED`] ?? process.env.USER1_SEED;
    if (!walletSeed) throw new Error(`${activeWallet}_SEED not found in .env`);
    lucid.selectWallet.fromSeed(walletSeed);
    await logWalletInfo(lucid, activeWallet);

    checkValidatorStaleness({ accountPolicyId, groupPolicyId: groupPolicyId! });

    const state = loadState();
    const accountTokenSuffix = state[accountSuffixKey(activeWallet)];
    if (!accountTokenSuffix) throw new Error(
        `${accountSuffixKey(activeWallet)} not found in state.json.\n` +
        `Run: ACTIVE_WALLET=${activeWallet} pnpm run create-account`
    );

    console.log(`Deferring next payout round for ${activeWallet}...`);
    console.log("After confirmation, distribute-payout will skip this member for the current round.");

    const config: DeferRoundConfig = { accountTokenSuffix };

    console.log("Building defer-round transaction...");
    const tx = await deferRound(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log(`Round deferred! ${activeWallet} will be skipped in the next distribute-payout call.`);
    console.log("The is_deferred flag resets automatically after the round is processed.");
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
