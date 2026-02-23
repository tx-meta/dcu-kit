import { createGroup, CreateGroupConfig, GroupDatum } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl } from "./context.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    const utxos = await lucid.wallet().getUtxos();
    if (utxos.length === 0) throw new Error("No UTxOs found. Please fund the wallet first.");

    const ONE_HOUR_MS = 3_600_000n;

    // All fees denominated in ADA: policy id = "" (empty), asset name = "" (empty)
    const groupDatum: GroupDatum = {
        contribution_fee_policyid: "",
        contribution_fee_assetname: "",
        contribution_fee: 5_000_000n,    // 5 ADA per interval

        joining_fee_policyid: "",
        joining_fee_assetname: "",
        joining_fee: 2_000_000n,         // 2 ADA to join

        penalty_fee_policyid: "",
        penalty_fee_assetname: "",
        penalty_fee: 1_000_000n,         // 1 ADA early-exit penalty

        interval_length: ONE_HOUR_MS,    // 1-hour intervals
        num_intervals: 12n,              // 12-member cycle

        member_count: 0n,
        share_holding: false,
        is_active: true,
        start_time: BigInt(Date.now()),
    };

    const config: CreateGroupConfig = {
        groupDatum,
        utxoToSpend: utxos[0],
    };

    console.log("Building transaction...");
    const tx = await createGroup(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    if (!isEmulator) console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log("Group created successfully!");
}

main().catch((e) => {
    console.error("Error:", e);
    process.exit(1);
});
