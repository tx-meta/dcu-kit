/**
 * Delete Account Example
 *
 * Burns both CIP-68 account tokens, permanently removing the DCU account.
 * The account must have no active group memberships — exit all groups first.
 *
 * Token suffix resolution order:
 *   1. state.json (accountTokenSuffix) — set by create-account.ts
 *   2. Auto-discovery — scans the wallet for an account auth token (222 prefix)
 */

import { deleteAccount, DeleteAccountConfig, accountPolicyId, assetNameLabels } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl, logError } from "./context.js";
import { loadState, saveState, clearState, checkValidatorStaleness } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires an existing on-chain account.");
        console.log("Run create-account.ts first, or use rosca-lifecycle.ts for a full emulator demo.");
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

    const config: DeleteAccountConfig = {
        accountTokenSuffix,
    };

    console.log("Building transaction...");
    const tx = await deleteAccount(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    clearState(["accountTokenSuffix"]);
    console.log("Account deleted successfully!");
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
