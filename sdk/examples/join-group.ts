/**
 * Join Group Example
 *
 * Joins a member to an existing ROSCA group.
 *
 * Wallet selection:
 *   Default (USER1):  uses USER1_SEED from .env
 *   ACTIVE_WALLET=WALLET3: uses WALLET3_SEED — joins as a second member
 *
 * Token suffix resolution:
 *   groupTokenSuffix:      state.json → auto-discover from wallet (222 prefix)
 *   accountTokenSuffix:    state.json (USER1 only) → auto-discover from wallet
 *
 * Live network: requires BLOCKFROST_KEY or MAESTRO_API_KEY in .env
 */

import { joinGroup, JoinGroupConfig, groupPolicyId, accountPolicyId, assetNameLabels, GroupDatum } from "@dcu/sdk";
import { Data } from "@lucid-evolution/lucid";
import { makeLucid, cexplorerTxUrl, logError } from "./context.js";
import { loadState, saveState, printSlotSchedule, accountSuffixKey } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires existing on-chain group and account.");
        console.log("See rosca-lifecycle.ts for a full emulator demonstration.");
        process.exit(0);
    }

    // Support ACTIVE_WALLET=WALLET3 to join as a second member.
    const activeWallet = (process.env.ACTIVE_WALLET ?? "USER1").toUpperCase();
    const walletSeed   = process.env[`${activeWallet}_SEED`] ?? process.env.USER1_SEED;
    if (!walletSeed) throw new Error(`${activeWallet}_SEED not found in .env`);
    lucid.selectWallet.fromSeed(walletSeed);
    if (activeWallet !== "USER1") console.log(`Using wallet: ${activeWallet}`);

    const suffixKey = accountSuffixKey(activeWallet);
    const state     = loadState();

    // Print current slot so you know where you are before spending gas.
    printSlotSchedule(state, []);

    let { groupTokenSuffix } = state;
    let accountTokenSuffix   = state[suffixKey];

    // Auto-discover groupTokenSuffix from the group admin (222) token in wallet
    if (!groupTokenSuffix) {
        console.log("groupTokenSuffix not in state.json — scanning wallet for group admin token...");
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

    // Auto-discover accountTokenSuffix from the active wallet's UTxOs
    if (!accountTokenSuffix) {
        console.log(`accountTokenSuffix not in state.json — scanning ${activeWallet} wallet for account token...`);
        const walletUtxos = await lucid.wallet().getUtxos();
        const accountUtxo = walletUtxos.find(u =>
            Object.keys(u.assets).some(k =>
                k.startsWith(accountPolicyId!) &&
                k.slice(accountPolicyId!.length).startsWith(assetNameLabels.prefix222)
            )
        );
        if (!accountUtxo) throw new Error(
            `No account token (222) found in ${activeWallet} wallet.\n` +
            `Run create-account.ts${activeWallet !== "USER1" ? ` with ACTIVE_WALLET=${activeWallet}` : ""} first.`
        );
        const key = Object.keys(accountUtxo.assets).find(k =>
            k.startsWith(accountPolicyId!) &&
            k.slice(accountPolicyId!.length).startsWith(assetNameLabels.prefix222)
        )!;
        accountTokenSuffix = key.slice(accountPolicyId!.length + assetNameLabels.prefix222.length);
        console.log("Found accountTokenSuffix:", accountTokenSuffix);
        saveState({ [suffixKey]: accountTokenSuffix });
    }

    // Fetch the group datum to compute the required contribution amount and current slot
    const groupUnit  = groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUtxo  = await lucid.utxoByUnit(groupUnit);
    if (!groupUtxo) throw new Error("Group UTxO not found on-chain. Is groupTokenSuffix correct?");
    const groupDatum = Data.from(groupUtxo.datum!, GroupDatum);
    const contributionAmount = groupDatum.num_intervals * groupDatum.contribution_fee;
    const assignedSlot = Number(groupDatum.member_count); // slot this member will get
    console.log(`Contribution: ${contributionAmount / 1_000_000n} ADA  |  Will be assigned slot: ${assignedSlot}`);

    const config: JoinGroupConfig = {
        groupTokenSuffix,
        accountTokenSuffix,
        contributionAmount,
    };

    console.log("Building join transaction...");
    const tx = await joinGroup(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log(`Joined group successfully as slot ${assignedSlot}!`);
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
