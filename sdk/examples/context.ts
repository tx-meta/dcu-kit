/**
 * Example Context Setup
 *
 * Reads provider and wallet configuration from environment variables (.env).
 * Controls which network/provider the examples use without changing code.
 *
 * Usage in .env:
 *   BLOCKFROST_KEY=preprod...   → Blockfrost on Preprod
 *   MAESTRO_API_KEY=...         → Maestro on Preprod
 *   (neither set)               → Emulator (local, no network required)
 *
 * Wallet seeds:
 *   USER1_SEED="..."   → primary user wallet (required for live network)
 *   ADMIN_SEED="..."   → admin wallet (required for live network group operations)
 */

import "dotenv/config";
import {
    Lucid,
    Blockfrost,
    Maestro,
    Emulator,
    PROTOCOL_PARAMETERS_DEFAULT,
    generateEmulatorAccount,
    LucidEvolution,
} from "@lucid-evolution/lucid";

export type ExampleContext = {
    lucid: LucidEvolution;
    isEmulator: boolean;
};

export async function makeLucid(): Promise<ExampleContext> {
    const blockfrostKey = process.env.BLOCKFROST_KEY;
    const maestroKey = process.env.MAESTRO_API_KEY;
    const network = (process.env.NETWORK as "Preprod" | "Mainnet" | "Preview") ?? "Preprod";

    // --- Blockfrost ---
    if (blockfrostKey) {
        const url = process.env.BLOCKFROST_URL ?? "https://cardano-preprod.blockfrost.io/api/v0";
        const lucid = await Lucid(new Blockfrost(url, blockfrostKey), network);
        const seed = process.env.USER1_SEED;
        if (!seed) throw new Error("USER1_SEED is required when BLOCKFROST_KEY is set");
        lucid.selectWallet.fromSeed(seed);
        console.log(`Provider: Blockfrost (${network})`);
        return { lucid, isEmulator: false };
    }

    // --- Maestro ---
    if (maestroKey) {
        const lucid = await Lucid(new Maestro({ network, apiKey: maestroKey, turboSubmit: false }), network);
        const seed = process.env.USER1_SEED;
        if (!seed) throw new Error("USER1_SEED is required when MAESTRO_API_KEY is set");
        lucid.selectWallet.fromSeed(seed);
        console.log(`Provider: Maestro (${network})`);
        return { lucid, isEmulator: false };
    }

    // --- Emulator (default) ---
    const user = generateEmulatorAccount({ lovelace: 100_000_000n });
    const emulator = new Emulator([user], { ...PROTOCOL_PARAMETERS_DEFAULT });
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(user.seedPhrase);
    console.log("Provider: Emulator");
    console.log("Wallet address:", user.address);
    return { lucid, isEmulator: true };
}

export function cexplorerTxUrl(txHash: string): string {
    const network = process.env.NETWORK ?? "Preprod";
    const subdomain = network === "Mainnet" ? "" : `${network.toLowerCase()}.`;
    return `https://${subdomain}cexplorer.io/tx/${txHash}`;
}
