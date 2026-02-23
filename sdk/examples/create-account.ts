import { fromText } from "@lucid-evolution/lucid";
import { createAccount, CreateAccountConfig } from "@dcu/sdk";
import { makeLucid, cexplorerTxUrl } from "./context.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    const utxos = await lucid.wallet().getUtxos();
    if (utxos.length === 0) throw new Error("No UTxOs in wallet. Please fund it first.");

    const config: CreateAccountConfig = {
        selected_out_ref: utxos[0],
        account_datum: {
            email_hash: fromText("business@web3.ada"),
            phone_hash: fromText("555-0199"),
        },
    };

    console.log("Building transaction...");
    const tx = await createAccount(lucid, config).unsafeRun();

    console.log("Signing and submitting...");
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("Transaction submitted. Hash:", txHash);
    if (!isEmulator) console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log("Account created successfully!");
}

main().catch((e) => {
    console.error("Error:", e);
    process.exit(1);
});
