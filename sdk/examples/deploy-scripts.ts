/**
 * Deploy Reference Scripts
 *
 * Deploys the treasury and group validators as reference-script UTxOs at the
 * admin's address. Once deployed, all subsequent transactions (joinGroup,
 * exitGroup, etc.) can reference these UTxOs instead of including the full
 * script bytes inline, keeping every transaction under Cardano's 16KB limit.
 *
 * Run this ONCE per validator set. The outRefs are saved to state.json and
 * loaded automatically by join-group.ts and exit-group.ts.
 *
 * Cost: ~30 ADA per script UTxO (min-UTxO for a ~6KB PlutusV3 script).
 * The ADA is locked at the admin's own address — it can be reclaimed if the
 * reference UTxOs are ever spent (though that would break future transactions
 * that rely on them).
 *
 * Usage:
 *   pnpm run deploy-scripts
 */

import { Data } from "@lucid-evolution/lucid";
import { treasuryValidator, groupValidator } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl, logError, logWalletInfo } from "./context.js";
import { loadState, saveState } from "./state.js";

// Generous ADA amounts to cover min-UTxO for large PlutusV3 reference scripts.
// treasury validator: ~6.4 KB → min ≈ 28 ADA
// group validator:    ~5.6 KB → min ≈ 24 ADA
const TREASURY_REF_ADA = 30_000_000n; // 30 ADA
const GROUP_REF_ADA    = 26_000_000n; // 26 ADA

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("deploy-scripts is for live networks only.");
        process.exit(0);
    }

    const adminSeed = process.env.ADMIN_SEED ?? process.env.USER1_SEED;
    if (!adminSeed) throw new Error("ADMIN_SEED not found in .env");
    lucid.selectWallet.fromSeed(adminSeed);
    await logWalletInfo(lucid, "ADMIN");

    const state = loadState();

    // If already deployed and still on-chain, skip.
    if (state.scriptRefTreasury && state.scriptRefGroup) {
        const [tUtxo] = await lucid.utxosByOutRef([
            { txHash: state.scriptRefTreasury.txHash, outputIndex: state.scriptRefTreasury.outputIndex }
        ]);
        const [gUtxo] = await lucid.utxosByOutRef([
            { txHash: state.scriptRefGroup.txHash, outputIndex: state.scriptRefGroup.outputIndex }
        ]);

        if (tUtxo?.scriptRef && gUtxo?.scriptRef) {
            console.log("Reference scripts already deployed and on-chain.");
            console.log("  treasury:", state.scriptRefTreasury.txHash.slice(0, 16) + "..." + `#${state.scriptRefTreasury.outputIndex}`);
            console.log("  group:   ", state.scriptRefGroup.txHash.slice(0, 16) + "..." + `#${state.scriptRefGroup.outputIndex}`);
            return;
        }
        console.log("Stored refs no longer on-chain — redeploying...");
    }

    const adminAddress = await lucid.wallet().address();

    // treasury.mint and treasury.spend share identical compiled CBOR, as do
    // group.mint and group.spend. One UTxO per validator covers both handlers.
    console.log("Deploying treasury validator reference script...");
    console.log("Deploying group validator reference script...");
    console.log(`Locking ${TREASURY_REF_ADA / 1_000_000n} ADA + ${GROUP_REF_ADA / 1_000_000n} ADA at admin address.`);

    const tx = await lucid.newTx()
        .pay.ToAddressWithData(
            adminAddress,
            { kind: "inline", value: Data.void() },
            { lovelace: TREASURY_REF_ADA },
            { type: "PlutusV3", script: treasuryValidator.mintTreasury.script }
        )
        .pay.ToAddressWithData(
            adminAddress,
            { kind: "inline", value: Data.void() },
            { lovelace: GROUP_REF_ADA },
            { type: "PlutusV3", script: groupValidator.spendGroup.script }
        )
        .complete();

    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);

    // Output 0 = treasury ref, output 1 = group ref (matches pay order above).
    saveState({
        scriptRefTreasury: { txHash, outputIndex: 0 },
        scriptRefGroup:    { txHash, outputIndex: 1 },
    });

    console.log("Reference scripts deployed and saved to state.json.");
    console.log("join-group and exit-group will now use these automatically.");
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
