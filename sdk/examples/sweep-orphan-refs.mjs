/**
 * Recover the min-ADA locked in orphaned reference scripts.
 *
 * Before the custody fix, `publishRefScript` paid reference scripts to the
 * operator's own wallet address. Every superseded deploy therefore left a
 * spendable UTxO carrying a dead script and its ~34-50 ADA deposit. This sweeps
 * them back into ordinary change.
 *
 * SAFETY: a UTxO is swept only if it is (a) at the operator wallet, (b) carrying
 * a scriptRef, and (c) NOT referenced by the deployment manifest. The manifest
 * check is the guard that stops this from destroying a live reference script.
 * Live refs sit at the alwaysFails address and are unspendable anyway, so the
 * check is belt-and-braces, not the only protection.
 *
 * Usage: from sdk/, `npx tsx examples/sweep-orphan-refs.mjs [--dry-run]`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import manifest from "../src/core/deployments/preprod.json" with { type: "json" };

const dryRun = process.argv.includes("--dry-run");
const env = {};
for (const line of readFileSync("./examples/.env", "utf8").split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#") && t.includes("=")) {
    const [k, ...v] = t.split("=");
    env[k.trim()] = v
      .join("=")
      .trim()
      .replace(/^["']|["']$/g, "");
  }
}
const lucid = await Lucid(
  new Blockfrost(env.BLOCKFROST_URL, env.BLOCKFROST_KEY),
  "Preprod",
);
lucid.selectWallet.fromSeed(env.USER1_SEED);
const address = await lucid.wallet().address();

const live = new Set(
  Object.values(manifest.refScripts).map((r) => `${r.txHash}#${r.outputIndex}`),
);

const utxos = await lucid.utxosAt(address);
const orphans = utxos.filter(
  (u) => u.scriptRef && !live.has(`${u.txHash}#${u.outputIndex}`),
);
if (orphans.length === 0) {
  console.log("no orphaned reference scripts at the operator wallet.");
  process.exit(0);
}

let total = 0n;
for (const u of orphans) {
  total += u.assets.lovelace ?? 0n;
  console.log(
    `  ${u.txHash}#${u.outputIndex}  ${Number(u.assets.lovelace) / 1e6} ADA` +
      `  ${u.scriptRef.script.length / 2} bytes`,
  );
}
console.log(
  `${orphans.length} orphans, ${Number(total) / 1e6} ADA recoverable.`,
);
if (dryRun) process.exit(0);

// Batch: each collected input costs script-size bytes in the witness-free body,
// so a large sweep can still exceed the tx ceiling. Ten at a time is safe.
for (let i = 0; i < orphans.length; i += 10) {
  const batch = orphans.slice(i, i + 10);
  const tx = await lucid
    .newTx()
    .collectFrom(batch)
    .complete({ presetWalletInputs: batch });
  const signed = await tx.sign.withWallet().complete();
  const hash = await signed.submit();
  console.log(`sweep ${i / 10 + 1}: ${hash}`);
  await lucid.awaitTx(hash);
  await new Promise((r) => setTimeout(r, 75_000));
}
console.log("\nSWEEP COMPLETE — the deposits are back in the operator wallet.");
