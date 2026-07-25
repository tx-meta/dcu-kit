/**
 * Live Preprod round-trip for the CIP-20 message path.
 *
 * Proves the two things the emulator and stubbed-fetch tests cannot:
 *   1. the real ledger accepts our byte-chunked label-674 metadata, and
 *   2. `getTxMessage` parses Blockfrost's *actual* response shape.
 *
 * Deliberately a self-payment: it creates no protocol state, mints nothing, and
 * leaves no orphaned tokens behind — only a fee.
 *
 *   npx tsx scripts/live-cip20-roundtrip.ts
 */
import "dotenv/config";
import { Blockfrost, Lucid } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  attachTxMessage,
  getWalletAddress,
  hashContent,
} from "../src/core/utils/index.js";
import { getTxMessage } from "../src/queries/getTxMessage.js";

// Multi-chunk (>64 bytes) and non-ASCII, so a naive character-based split would
// corrupt it and a naive byte-based split would cut a codepoint in half.
const MESSAGE =
  "Kiambu land-buying chama — mchango wa mwezi wa tatu, 🌍 pamoja tunaweza kujenga.";

const url = process.env.BLOCKFROST_URL!;
const projectId = process.env.BLOCKFROST_KEY!;
const seed = process.env.ADMIN_SEED!;

const main = async () => {
  console.log(`message: ${MESSAGE}`);
  console.log(
    `bytes:   ${new TextEncoder().encode(MESSAGE).length} (chunks into ${Math.ceil(
      new TextEncoder().encode(MESSAGE).length / 64,
    )} metadatum strings)`,
  );
  console.log(`hash:    ${hashContent(MESSAGE)}\n`);

  const lucid = await Lucid(new Blockfrost(url, projectId), "Preprod");
  lucid.selectWallet.fromSeed(seed);

  const address = await Effect.runPromise(getWalletAddress(lucid));
  console.log(`wallet:  ${address.slice(0, 24)}…`);

  // Self-payment carrying the message.
  const base = lucid.newTx().pay.ToAddress(address, { lovelace: 2_000_000n });
  const withMessage = await Effect.runPromise(attachTxMessage(base, MESSAGE));
  const tx = await withMessage.complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`submitted: ${txHash}`);

  console.log("awaiting confirmation…");
  await lucid.awaitTx(txHash);
  console.log("confirmed.\n");

  // Blockfrost indexes metadata a little after the block lands.
  let readBack: string | null = null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    readBack = await Effect.runPromise(
      getTxMessage({ url, projectId }, txHash),
    );
    if (readBack !== null) break;
    console.log(
      `  metadata not indexed yet (attempt ${attempt}) — waiting 10s`,
    );
    await new Promise((r) => setTimeout(r, 10_000));
  }

  console.log(`\nread back: ${readBack}`);

  const exact = readBack === MESSAGE;
  const hashMatches =
    readBack !== null && hashContent(readBack) === hashContent(MESSAGE);
  console.log(`byte-exact round trip: ${exact}`);
  console.log(`hash commitment matches: ${hashMatches}`);

  if (!exact || !hashMatches) {
    console.error("\nROUND-TRIP FAILED");
    process.exit(1);
  }
  console.log(
    `\nROUND-TRIP PASSED — https://preprod.cardanoscan.io/transaction/${txHash}`,
  );
};

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
