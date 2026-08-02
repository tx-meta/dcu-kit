/**
 * Publish the LOCAL savings validator as a Preprod reference script and print
 * the manifest entry.
 *
 * Distinct from `savings-deploy.ts`, which imports the published tarball: after
 * a hash-changing edit that build is stale, so it would redeploy the OLD
 * script. This one imports ../src directly.
 *
 * The old reference is left alive on purpose. It sits at alwaysFails and can
 * never be spent, so anything still bound to the previous hash keeps working.
 *
 * Usage: from sdk/, `npx tsx examples/redeploy-savings-ref.mjs`
 */
import { readFileSync } from "node:fs";
import {
  Lucid,
  Blockfrost,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { deployModuleScripts } from "../src/admin/deployModuleScripts.js";
import { savingsVaultValidator } from "../src/savings/validators.js";
import manifest from "../src/core/deployments/preprod.json" with { type: "json" };

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

const script = savingsVaultValidator.spendVault;
const hash = validatorToScriptHash(script);
console.log("local savings hash:", hash);
console.log("manifest records:  ", manifest.refScripts.savings.scriptHash);
if (hash === manifest.refScripts.savings.scriptHash) {
  console.log("unchanged — nothing to deploy.");
  process.exit(0);
}
console.log("script bytes:", script.script.length / 2);

const result = await Effect.runPromise(
  deployModuleScripts({ savings: script }, lucid, {
    existing: {
      savings: {
        txHash: manifest.refScripts.savings.txHash,
        outputIndex: manifest.refScripts.savings.outputIndex,
      },
    },
  }),
);
const ref = result.refs.savings;
console.log("status:", result.status.savings);
console.log("deployAddress:", result.deployAddress);
console.log("\nmanifest entry — paste into preprod.json refScripts.savings:");
console.log(
  JSON.stringify(
    { txHash: ref.txHash, outputIndex: ref.outputIndex, scriptHash: hash },
    null,
    2,
  ),
);
