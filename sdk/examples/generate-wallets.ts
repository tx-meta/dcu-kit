/**
 * Wallet Generator
 *
 * Generates BIP39 seed phrases and derives Cardano addresses for each wallet.
 * Prints ready-to-paste .env entries for USER1_SEED and ADMIN_SEED.
 *
 * Usage:
 *   pnpm run generate-wallets           → generates USER1 + ADMIN
 *   pnpm run generate-wallets -- --count 3  → generates 3 wallets
 *
 * After running, copy the seed phrases into sdk/examples/.env and fund the
 * addresses from the Preprod faucet: https://docs.cardano.org/cardano-testnets/tools/faucet/
 */

import { generateSeedPhrase, walletFromSeed } from "@lucid-evolution/lucid";

const WALLET_NAMES = ["USER1", "ADMIN"];
const FAUCET_URL = "https://docs.cardano.org/cardano-testnets/tools/faucet/";

const countArg = process.argv.indexOf("--count");
const count = countArg !== -1 ? parseInt(process.argv[countArg + 1], 10) : 2;

if (isNaN(count) || count < 1) {
    console.error("--count must be a positive integer");
    process.exit(1);
}

const network = (process.env.NETWORK as "Preprod" | "Mainnet" | "Preview") ?? "Preprod";

console.log(`Generating ${count} wallet(s) for ${network}...\n`);
console.log("=".repeat(60));

const envLines: string[] = [];

for (let i = 0; i < count; i++) {
    const name = WALLET_NAMES[i] ?? `WALLET${i + 1}`;
    const seedPhrase = generateSeedPhrase();
    const { address, rewardAddress } = walletFromSeed(seedPhrase, {
        addressType: "Base",
        accountIndex: 0,
        network,
    });

    console.log(`\n${name}`);
    console.log("-".repeat(60));
    console.log(`Address:        ${address}`);
    console.log(`Reward address: ${rewardAddress}`);
    console.log(`Seed phrase:    ${seedPhrase}`);

    envLines.push(`${name}_SEED="${seedPhrase}"`);
}

console.log("\n" + "=".repeat(60));
console.log("\nAdd to sdk/examples/.env:\n");
console.log(envLines.join("\n"));
console.log("\nFund addresses on Preprod:");
console.log(FAUCET_URL);
