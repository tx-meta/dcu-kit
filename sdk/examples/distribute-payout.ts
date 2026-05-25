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

import { distributePayout, DistributePayoutConfig, accountPolicyId, groupPolicyId, GroupDatum, TreasuryDatum, TreasuryDatumSchema, treasuryValidator, assetNameLabels } from "@dcu/sdk";
import { Data, UTxO, validatorToAddress } from "@lucid-evolution/lucid";
import { makeLucid, cexplorerTxUrl, logError, logWalletInfo } from "./context.js";
import { loadState, printSlotSchedule, computeSlotInfo, checkValidatorStaleness } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    if (isEmulator) {
        console.log("This example requires an active group with treasury UTxOs.");
        console.log("These example scripts require existing on-chain state. Run on Preprod.");
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

    // Read on-chain group datum to show what round will be distributed next.
    // This is the authoritative source — the time-based slot display below is
    // just a human-readable clock; the actual round is driven by last_distributed_round.
    const groupUnit  = groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUtxo  = await lucid.utxoByUnit(groupUnit);
    if (!groupUtxo) throw new Error("Group UTxO not found on-chain. Is groupTokenSuffix correct?");
    const groupDatum = Data.from(groupUtxo.datum!, GroupDatum);

    const nextRound  = groupDatum.last_distributed_round + 1n;
    const totalRounds = groupDatum.num_intervals;

    if (nextRound >= totalRounds) {
        console.log(`\nAll ${totalRounds} rounds have been distributed (rounds 0–${totalRounds - 1n} complete).`);
        console.log("Group is mature — members can now call: pnpm run exit-group");
        process.exit(0);
    }

    const primarySlot  = Number(nextRound % totalRounds);
    const numIntervals = Number(totalRounds);
    const payoutAda    = (BigInt(groupDatum.member_count) * groupDatum.contribution_fee) / 1_000_000n;

    // Resolve effective recipient: query treasury UTxOs to check is_deferred on primary slot.
    // Mirrors the SDK routing logic so the log matches what the validator actually does.
    const groupRefName = (groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix).slice(groupPolicyId!.length);
    let effectiveSlot  = primarySlot;
    let deferredNote   = "";
    try {
        const network      = lucid.config().network!;
        const tAddr        = validatorToAddress(network, treasuryValidator.spendTreasury);
        const tUtxos       = await lucid.utxosAt(tAddr);
        const credBySlot   = new Map<number, boolean>(); // slot → is_deferred
        for (const tu of tUtxos) {
            try {
                const raw = Data.from(tu.datum!, TreasuryDatumSchema) as unknown as TreasuryDatum;
                if (!("TreasuryState" in raw)) continue;
                const ts = raw.TreasuryState;
                if (ts.group_reference_tokenname !== groupRefName) continue;
                if (ts.rounds_paid !== nextRound) continue;
                credBySlot.set(Number(ts.assigned_slot), ts.is_deferred);
            } catch { /* skip malformed */ }
        }
        if (credBySlot.get(primarySlot) === true) {
            effectiveSlot = (primarySlot + 1) % numIntervals;
            deferredNote  = `Slot ${primarySlot} deferred — routing to slot ${effectiveSlot}`;
        }
    } catch { /* best-effort display, non-fatal */ }

    console.log(`→ Next:  Round ${nextRound + 1n} of ${totalRounds}  |  Primary slot: ${primarySlot}  |  Paying to: slot ${effectiveSlot}  |  Payout: ${payoutAda} ADA`);
    if (deferredNote) console.log(`   (${deferredNote})`);

    // Time-based slot display (for reference — shows wall-clock progress through intervals).
    const slotInfo = computeSlotInfo(state);
    if (slotInfo) {
        const secsLeft = Math.ceil(slotInfo.msUntilNextSlot / 1000);
        console.log(`Time-based slot: ${slotInfo.currentSlot}  (next slot in ${secsLeft}s)`);
    }
    printSlotSchedule(state, [0, 1]); // adjust member slots as needed

    // Load reference script UTxOs — reduces tx size from ~19KB to ~4KB.
    // Deploy once with: pnpm run deploy-scripts
    let scriptRefs: DistributePayoutConfig["scriptRefs"];
    if (state.scriptRefTreasury && state.scriptRefGroup) {
        const [tUtxo, gUtxo] = await lucid.utxosByOutRef([
            { txHash: state.scriptRefTreasury.txHash, outputIndex: state.scriptRefTreasury.outputIndex },
            { txHash: state.scriptRefGroup.txHash,    outputIndex: state.scriptRefGroup.outputIndex },
        ]);
        if (tUtxo?.scriptRef && gUtxo?.scriptRef) {
            scriptRefs = { treasury: tUtxo as UTxO, group: gUtxo as UTxO };
            console.log("Using reference scripts — tx will be under 16KB.");
        } else {
            console.warn("Reference script UTxOs not found on-chain — falling back to inline scripts.");
            console.warn("Run 'pnpm run deploy-scripts' to deploy them.");
        }
    } else {
        console.warn("No script refs in state.json — falling back to inline scripts (may exceed 16KB).");
        console.warn("Run 'pnpm run deploy-scripts' first.");
    }

    const config: DistributePayoutConfig = {
        groupTokenSuffix,
        scriptRefs,
    };

    console.log("Building payout transaction...");
    const tx = await distributePayout(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();

    let txHash: string;
    try {
        txHash = await signed.submit();
    } catch (e: unknown) {
        // OutsideValidityIntervalUTxO: network slot lags local clock by > 120 s.
        // The tx must be rebuilt with a fresh validFrom — just rerun this script.
        if (String(e).includes("OutsideValidityInterval")) {
            console.error("\n[Clock drift] Network slot is behind local clock.");
            console.error("Wait 30 seconds and run distribute-payout again.");
            process.exit(1);
        }
        throw e;
    }

    console.log("Transaction submitted. Hash:", txHash);
    console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log(`Payout confirmed!  Round ${nextRound + 1n} of ${totalRounds} complete.`);
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
