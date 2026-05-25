/**
 * Update Account Example
 *
 * Updates the email/phone hashes on an existing DCU account.
 *
 * Token suffix resolution order:
 *   1. state.json (accountTokenSuffix) — set by create-account.ts
 *   2. Auto-discovery — scans the wallet for an account auth token (222 prefix)
 */

import { updateAccount, UpdateAccountConfig, accountPolicyId, assetNameLabels } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl, logError } from "./context.js";
import { loadState, saveState, checkValidatorStaleness } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires an existing on-chain account.");
        console.log("These scripts require existing on-chain state. Run on Preprod.");
        process.exit(0);
    }

    checkValidatorStaleness({ accountPolicyId });

    let { accountTokenSuffix } = loadState();

    if (!accountTokenSuffix) {
        console.log("accountTokenSuffix not in state.json — scanning wallet for account auth token...");
        const walletUtxos = await lucid.wallet().getUtxos();
        const authUtxo = walletUtxos.find(u =>
            Object.keys(u.assets).some(k =>
                k.startsWith(accountPolicyId) &&
                k.slice(accountPolicyId.length).startsWith(assetNameLabels.prefix222)
            )
        );
        if (!authUtxo) throw new Error(
            "No account auth token (222) found in wallet and no accountTokenSuffix in state.json.\n" +
            "Run create-account.ts first."
        );
        const key = Object.keys(authUtxo.assets).find(k =>
            k.startsWith(accountPolicyId) &&
            k.slice(accountPolicyId.length).startsWith(assetNameLabels.prefix222)
        )!;
        accountTokenSuffix = key.slice(accountPolicyId.length + assetNameLabels.prefix222.length);
        console.log("Found accountTokenSuffix:", accountTokenSuffix);
        saveState({ accountTokenSuffix });
    }

    const config: UpdateAccountConfig = {
        accountTokenSuffix,
        email: "updated@dcu.io",
        phone: "555-9999",
    };

    console.log("Building transaction...");
    const tx = await updateAccount(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log("Account updated successfully!");
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
