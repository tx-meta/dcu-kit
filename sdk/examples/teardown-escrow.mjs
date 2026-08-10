/**
 * Preprod teardown, phase 2: retire the P2 D3 escrow, pool and project.
 *
 * All three are authorized by ADMIN at accountIndex 1 (payment credential
 * b8c0213d…), the dedicated wallet p2-d3-skip-smoke.ts used. Selecting ADMIN at
 * the default account index authorizes none of them.
 *
 * The escrow is reclaimed, not timed out: its timeoutPolicy is RefundToFunder,
 * so timeoutRelease does not apply.
 *
 * Usage: from sdk/, `npx tsx examples/teardown-escrow.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { unsignedReclaimEscrowV2TxProgram } from "../src/escrow/v2/endpoints/reclaimEscrow.js";
import { unsignedClosePoolTxProgram } from "../src/escrow/v2/endpoints/closePool.js";
import { unsignedCloseProjectTxProgram } from "../src/escrow/v2/endpoints/closeProject.js";
import manifest from "../src/core/deployments/preprod.json" with { type: "json" };

const env = {};
for (const line of readFileSync("./examples/.env", "utf8").split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#") && t.includes("=")) {
    const [k, ...v] = t.split("=");
    env[k.trim()] = v.join("=").trim().replace(/^["']|["']$/g, "");
  }
}
const lucid = await Lucid(
  new Blockfrost(env.BLOCKFROST_URL, env.BLOCKFROST_KEY),
  "Preprod",
);
lucid.selectWallet.fromSeed(env.ADMIN_SEED, { accountIndex: 1 });
console.log("signer:", await lucid.wallet().address());

const settle = (s = 45) => new Promise((r) => setTimeout(r, s * 1000));
const [escrowRef] = await lucid.utxosByOutRef([
  {
    txHash: manifest.refScripts.escrowV2.txHash,
    outputIndex: manifest.refScripts.escrowV2.outputIndex,
  },
]);
const scriptRefs = { escrow: escrowRef };

const ESCROW = "b3b8c5c20bd4dcd22e7f492c5f0fcb60e3c9a19a8c4af1e382cef33c6d11edc5";
const POOL = "35591aa110b6a6accb00cda1815bbd67595af20e45b694d21b344f695021622f";
const PROJECT = "0464d147a9f63a2ffed884536015714ee3578547695401ad573c0169eb9e06a0";

const run = async (label, program) => {
  const built = await Effect.runPromise(Effect.either(program));
  if (built._tag !== "Right") {
    console.log(`${label}: BUILD FAILED ${String(built.left).slice(0, 300)}`);
    return false;
  }
  try {
    const signed = await built.right.sign.withWallet().complete();
    const hash = await signed.submit();
    console.log(`${label}: ${hash}`);
    await lucid.awaitTx(hash);
    await settle();
    return true;
  } catch (e) {
    console.log(`${label}: SUBMIT FAILED ${String(e).slice(0, 300)}`);
    return false;
  }
};

await run(
  "reclaimEscrow",
  unsignedReclaimEscrowV2TxProgram(lucid, {
    scriptRefs,
    stateTokenName: ESCROW,
  }),
);
await run(
  "closePool",
  unsignedClosePoolTxProgram(lucid, { scriptRefs, poolTokenName: POOL }),
);
await run(
  "closeProject",
  unsignedCloseProjectTxProgram(lucid, {
    scriptRefs,
    projectTokenName: PROJECT,
  }),
);
