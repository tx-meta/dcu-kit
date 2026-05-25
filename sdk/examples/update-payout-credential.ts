/**
 * Update Payout Credential Example
 *
 * Updates the member_payment_credential in a treasury UTxO datum so that
 * future payout distributions are sent to the current wallet's address.
 *
 * Use case: a member has rotated their receiving wallet and wants the ROSCA
 * payout to land at their new address. The new credential is derived from
 * the signing wallet — proving ownership — and the Aiken validator re-derives
 * and verifies it from the input UTxO's payment key.
 *
 * Wallet selection:
 *   Default (USER1): uses USER1_SEED
 *   ACTIVE_WALLET=USER2: uses USER2_SEED
 *   ACTIVE_WALLET=ADMIN: uses ADMIN_SEED
 *
 * Reads accountTokenSuffix from state.json (keyed by active wallet).
 */

import { updatePayoutCredential, UpdatePayoutCredentialConfig, accountPolicyId, groupPolicyId } from "@dcu/sdk";
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

    console.log(`Updating payout destination for ${activeWallet} to current wallet address...`);
    console.log("Future distribute-payout calls will send the payout to the signing wallet.");

    const config: UpdatePayoutCredentialConfig = { accountTokenSuffix };

    console.log("Building update-payout-credential transaction...");
    const tx = await updatePayoutCredential(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log(`Payout credential updated! ${activeWallet}'s payouts will now go to the current wallet.`);
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
