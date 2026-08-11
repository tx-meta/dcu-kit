/**
 * Preprod teardown, phase 4: the only ROSCA wind-down reachable from this repo.
 *
 * Group 29afcd9a… is the one live group whose admin (222) token USER1 holds.
 * Deactivating it is one way and makes every remaining exit penalty-free
 * (validate_exit_treasury: an exit is early only while is_active && is_started
 * && !completed_full_cycle). USER1 then leaves their own position, taking their
 * share of the mutual reserve with them.
 *
 * deleteGroup is NOT attempted: it needs member_count == 0, and the second
 * member is an external wallet. The other two live groups are admin-held by
 * external wallets and cannot be touched here at all.
 *
 * Usage: from sdk/, `npx tsx examples/teardown-rosca.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost, Data } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { buildProtocol } from "../src/core/validators/constants.js";
import { GroupCip68Datum } from "../src/core/types.js";
import { assetNameLabels } from "../src/core/utils/index.js";
import { unsignedUpdateGroupTxProgram } from "../src/endpoints/updateGroup.js";
import { unsignedExitGroupTxProgram } from "../src/endpoints/exitGroup.js";
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
const GROUP = "29afcd9a9ab7b15aae0d67305e2fceef1f47ad4f92550a0bee6f827c";
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

const groupUtxo = await lucid.utxoByUnit(
  protocol.groupPolicyId + assetNameLabels.prefix100 + GROUP,
);
const current = Data.from(groupUtxo.datum, GroupCip68Datum).extra;
console.log(
  `group ${GROUP.slice(0, 12)}…  is_active=${current.is_active} is_started=${current.is_started} members=${current.member_count}`,
);

if (current.is_active) {
  await run(
    "updateGroup is_active=false",
    unsignedUpdateGroupTxProgram(protocol, lucid, {
      groupTokenSuffix: GROUP,
      updatedDatum: { ...current, is_active: false },
    }),
  );
} else {
  console.log("already deactivated, skipping");
}

await run(
  "exitGroup USER1",
  unsignedExitGroupTxProgram(protocol, lucid, {
    groupTokenSuffix: GROUP,
    accountTokenSuffix: ACCOUNT,
    claimReserveShare: true,
    scriptRefs,
  }),
);

const after = await lucid.utxoByUnit(
  protocol.groupPolicyId + assetNameLabels.prefix100 + GROUP,
);
const d = Data.from(after.datum, GroupCip68Datum).extra;
console.log(
  `\nfinal: is_active=${d.is_active} members=${d.member_count} activeMembers=${d.active_member_count}`,
);
console.log(
  "deleteGroup needs member_count == 0; the remaining member is an external wallet.",
);
