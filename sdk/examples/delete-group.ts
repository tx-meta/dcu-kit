/**
 * Delete Group Example
 *
 * Deactivates a group by setting is_active to false (soft delete).
 * The group UTxO remains on-chain but is non-functional.
 * Requires member_count === 0.
 *
 * Token suffix resolution order:
 *   1. state.json (groupTokenSuffix) — set by create-group.ts
 *   2. Auto-discovery — scans admin wallet for a group admin token (222 prefix)
 */

import { deleteGroup, DeleteGroupConfig, groupPolicyId, assetNameLabels } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl, logError } from "./context.js";
import { loadState, saveState, clearState } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires an existing on-chain group.");
        console.log("Run create-group.ts first, or use rosca-lifecycle.ts for a full emulator demo.");
        process.exit(0);
    }

    const adminSeed = process.env.ADMIN_SEED ?? process.env.USER1_SEED;
    if (!adminSeed) throw new Error("ADMIN_SEED or USER1_SEED is required.");
    lucid.selectWallet.fromSeed(adminSeed);

    let { groupTokenSuffix } = loadState();

    if (!groupTokenSuffix) {
        console.log("groupTokenSuffix not in state.json — scanning admin wallet for group admin token...");
        const walletUtxos = await lucid.wallet().getUtxos();
        const adminUtxo = walletUtxos.find(u =>
            Object.keys(u.assets).some(k =>
                k.startsWith(groupPolicyId!) &&
                k.slice(groupPolicyId!.length).startsWith(assetNameLabels.prefix222)
            )
        );
        if (!adminUtxo) throw new Error(
            "No group admin token (222) found in wallet and no groupTokenSuffix in state.json.\n" +
            "Run create-group.ts first."
        );
        const key = Object.keys(adminUtxo.assets).find(k =>
            k.startsWith(groupPolicyId!) &&
            k.slice(groupPolicyId!.length).startsWith(assetNameLabels.prefix222)
        )!;
        groupTokenSuffix = key.slice(groupPolicyId!.length + assetNameLabels.prefix222.length);
        console.log("Found groupTokenSuffix:", groupTokenSuffix);
        saveState({ groupTokenSuffix });
    }

    const config: DeleteGroupConfig = {
        groupTokenSuffix,
    };

    console.log("Building transaction...");
    const tx = await deleteGroup(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    clearState(["groupTokenSuffix"]);
    console.log("Group deactivated successfully!");
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
