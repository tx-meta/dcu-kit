/**
 * Preprod teardown, phase 6: USER1's last remaining position.
 *
 * USER1 is a member of group 8ada55c9…, whose admin token is an external
 * wallet. The group is is_started == false, so the exit is free and burns the
 * membership token (validate_exit_treasury: an exit is early only while
 * is_active && is_started && !completed_full_cycle). No admin cooperation is
 * needed to leave, only to delete the group itself.
 *
 * With that position gone, the account token is bound to no live treasury and
 * deleteAccount burns the CIP-68 pair.
 *
 * Usage: from sdk/, `npx tsx examples/teardown-last-account.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { buildProtocol } from "../src/core/validators/constants.js";
import { unsignedExitGroupTxProgram } from "../src/endpoints/exitGroup.js";
import { unsignedDeleteAccountTxProgram } from "../src/endpoints/deleteAccount.js";
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
lucid.selectWallet.fromSeed(env.USER1_SEED);

const settle = (s = 45) => new Promise((r) => setTimeout(r, s * 1000));
const ref = async (key) => {
  const e = manifest.refScripts[key];
  const [u] = await lucid.utxosByOutRef([
    { txHash: e.txHash, outputIndex: e.outputIndex },
  ]);
  return u;
};
const scriptRefs = {
  treasury: await ref("treasury"),
  group: await ref("group"),
  treasuryRounds: await ref("treasuryRounds"),
  treasuryLifecycle: await ref("treasuryLifecycle"),
  treasuryRecovery: await ref("treasuryRecovery"),
  treasuryReserve: await ref("treasuryReserve"),
};
const protocol = buildProtocol(manifest.settingsPolicy);

const GROUP = "8ada55c9a08c8bd5975f4109d1802ee6cc30f0179c40addba7e24392";
const ACCOUNT = "b314ee9cd6b87c8e2916768684318b38adcad80e3fd5375c829a68bb";

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

const exited = await run(
  "exitGroup USER1 from 8ada55c9…",
  unsignedExitGroupTxProgram(protocol, lucid, {
    groupTokenSuffix: GROUP,
    accountTokenSuffix: ACCOUNT,
    scriptRefs,
  }),
);

if (exited) {
  await run(
    "deleteAccount USER1",
    unsignedDeleteAccountTxProgram(protocol, lucid, {
      accountTokenSuffix: ACCOUNT,
    }),
  );
}
