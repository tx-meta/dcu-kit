import "dotenv/config";
import {
    Lucid,
    Blockfrost,
    Emulator,
    PROTOCOL_PARAMETERS_DEFAULT,
    generateEmulatorAccount,
    fromText,
} from "@lucid-evolution/lucid";
import { createAccount, CreateAccountConfig } from "@dcu/sdk";

// --- Context Setup ---

async function makeLucid() {
    const apiKey = process.env.BLOCKFROST_KEY;

    if (apiKey) {
        // Live Network (Preprod)
        const blockfrost = new Blockfrost(
            "https://cardano-preprod.blockfrost.io/api/v0",
            apiKey
        );
        const lucid = await Lucid(blockfrost, "Preprod");

        const seed = process.env.USER1_SEED;
        if (!seed) throw new Error("USER1_SEED env var required for live network");
        lucid.selectWallet.fromSeed(seed);
        return lucid;
    }

    // Emulator Fallback
    const user = generateEmulatorAccount({ lovelace: 100_000_000n });
    const emulator = new Emulator([user], { ...PROTOCOL_PARAMETERS_DEFAULT });
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(user.seedPhrase);
    console.log("Running on Emulator. User address:", user.address);
    return lucid;
}

// --- Main ---

async function main() {
    const lucid = await makeLucid();

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
    if (process.env.BLOCKFROST_KEY) {
        console.log(`View on Cexplorer: https://preprod.cexplorer.io/tx/${txHash}`);
    }

    console.log("Waiting for confirmation...");
    await lucid.awaitTx(txHash);
    console.log("Account created successfully!");
}

main().catch((e) => {
    console.error("Error:", e);
    process.exit(1);
});
