/**
 * Send ADA — utility for moving funds between test wallets.
 *
 * Reads FROM_WALLET and TO_WALLET from the environment (default: USER1 → ADMIN).
 * Sends AMOUNT lovelace (default 10 ADA) from the source wallet to the target.
 *
 * Usage:
 *   pnpm run send-ada                                → USER1 sends 10 ADA to ADMIN
 *   FROM_WALLET=USER1 TO_WALLET=USER2 pnpm run send-ada
 *   AMOUNT=5000000 FROM_WALLET=ADMIN TO_WALLET=USER1 pnpm run send-ada
 */

import "dotenv/config";
import { Lucid, Blockfrost, Maestro } from "@lucid-evolution/lucid";
import { makeLucid, cexplorerTxUrl, logError } from "./context.js";

const LIVE_NETWORKS = ["Preprod", "Mainnet", "Preview"] as const;
type LiveNetwork = (typeof LIVE_NETWORKS)[number];
function liveNetwork(raw: string | undefined): LiveNetwork | null {
  return (LIVE_NETWORKS as readonly string[]).includes(raw ?? "")
    ? (raw as LiveNetwork)
    : null;
}

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log(
      "send-ada requires a live network (set BLOCKFROST_KEY or MAESTRO_API_KEY in .env).",
    );
    process.exit(0);
  }

  const fromWallet = (process.env.FROM_WALLET ?? "USER1").toUpperCase();
  const toWallet = (process.env.TO_WALLET ?? "ADMIN").toUpperCase();
  const amount = BigInt(process.env.AMOUNT ?? "10000000"); // 10 ADA default

  const fromSeed = process.env[`${fromWallet}_SEED`] ?? process.env.USER1_SEED;
  const toSeed = process.env[`${toWallet}_SEED`];

  if (!fromSeed) throw new Error(`${fromWallet}_SEED not found in .env`);
  if (!toSeed) throw new Error(`${toWallet}_SEED not found in .env`);

  // Derive the destination address from the TO_WALLET seed (no tx needed — just derive)
  const network = liveNetwork(process.env.NETWORK) ?? "Preprod";
  const toAddrLucid = await (() => {
    const blockfrostKey = process.env.BLOCKFROST_KEY;
    const maestroKey = process.env.MAESTRO_API_KEY;
    if (blockfrostKey) {
      const url =
        process.env.BLOCKFROST_URL ??
        "https://cardano-preprod.blockfrost.io/api/v0";
      return Lucid(new Blockfrost(url, blockfrostKey), network);
    }
    if (maestroKey) {
      return Lucid(
        new Maestro({ network, apiKey: maestroKey, turboSubmit: false }),
        network,
      );
    }
    throw new Error("No provider configured");
  })();
  toAddrLucid.selectWallet.fromSeed(toSeed);
  const toAddress = await toAddrLucid.wallet().address();

  // Switch lucid to the FROM wallet and send
  lucid.selectWallet.fromSeed(fromSeed);
  const fromAddress = await lucid.wallet().address();

  console.log(`From: ${fromWallet} (${fromAddress})`);
  console.log(`To:   ${toWallet}   (${toAddress})`);
  console.log(`Amount: ${amount / 1_000_000n} ADA (${amount} lovelace)`);

  const utxos = await lucid.wallet().getUtxos();
  if (utxos.length === 0) throw new Error(`${fromWallet} wallet has no UTxOs.`);

  const tx = await lucid
    .newTx()
    .pay.ToAddress(toAddress, { lovelace: amount })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  console.log("\nTransaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  console.log("\nWaiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log(`Done! ${fromWallet} → ${toWallet}: ${amount / 1_000_000n} ADA`);
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
