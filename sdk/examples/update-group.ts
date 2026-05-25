/**
 * Update Group Example
 *
 * Updates a group's configuration (e.g. fees or active state).
 * Critical fields (fees, intervals) can only be changed while member_count === 0.
 *
 * Token suffix resolution order:
 *   1. state.json (groupTokenSuffix) — set by create-group.ts
 *   2. Auto-discovery — scans admin wallet for a group admin token (222 prefix)
 */

import { updateGroup, UpdateGroupConfig, GroupDatum, groupPolicyId, assetNameLabels } from "@dcu/sdk";
import { Data } from "@lucid-evolution/lucid";
import { makeLucid, cexplorerTxUrl, logError, logWalletInfo } from "./context.js";
import { loadState, saveState, checkValidatorStaleness } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires an existing on-chain group.");
        console.log("These scripts require existing on-chain state. Run on Preprod.");
        process.exit(0);
    }

    const adminSeed = process.env.ADMIN_SEED ?? process.env.USER1_SEED;
    if (!adminSeed) throw new Error("ADMIN_SEED or USER1_SEED is required.");
    lucid.selectWallet.fromSeed(adminSeed);
    await logWalletInfo(lucid, "ADMIN");

    checkValidatorStaleness({ groupPolicyId: groupPolicyId! });

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

    // Fetch the current datum to construct the update.
    const groupUnit = groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUtxo = await lucid.utxoByUnit(groupUnit);
    if (!groupUtxo) throw new Error("Group UTxO not found on-chain.");
    const currentDatum = Data.from(groupUtxo.datum!, GroupDatum);

    // Critical fields (fees, intervals, admin_payment_credential, start_time, max_members)
    // are frozen while any member is active. The only non-critical update allowed with
    // active members is deactivation (is_active: true → false).
    let updatedDatum: GroupDatum;
    if (!currentDatum.is_active) {
        console.log("Group is already deactivated. Run delete-group next.");
        process.exit(0);
    }
    if (currentDatum.member_count === 0n) {
        // No members and still active — deactivate so deleteGroup can proceed.
        updatedDatum = { ...currentDatum, is_active: false };
        console.log("member_count=0, is_active=true → deactivating group for deletion.");
    } else {
        // Members still in the group — deactivate to signal exit window (all exits become penalty-free).
        console.log(`member_count=${currentDatum.member_count} — deactivating group (is_active: true → false).`);
        console.log("NOTE: deactivation is irreversible — all future exits will be penalty-free (mature path).");
        updatedDatum = { ...currentDatum, is_active: false };
    }

    const config: UpdateGroupConfig = {
        groupTokenSuffix,
        updatedDatum,
    };

    console.log("Building transaction...");
    const tx = await updateGroup(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log("Group updated successfully!");
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
