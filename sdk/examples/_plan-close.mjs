/**
 * Per-group wind-down planner: for every live ROSCA group, list the treasury
 * UTxOs bound to it, decode each member's state, and say which of our wallets
 * (including alternate account indices) holds the account token that must sign.
 *
 * Usage: from sdk/, `npx tsx examples/_plan-close.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost, Data, paymentCredentialOf } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  buildProtocol,
  accountPolicyId,
  assetNameLabels,
  GroupCip68Datum,
  TreasuryDatumSchema,
  getScriptAddress,
  parseSafeDatum,
} from "../src/index.js";
import manifest from "../src/core/deployments/preprod.json" with { type: "json" };

const env = {};
for (const line of readFileSync("./examples/.env", "utf8").split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#") && t.includes("=")) {
    const [k, ...v] = t.split("=");
    env[k.trim()] = v.join("=").trim().replace(/^["']|["']$/g, "");
  }
}
const URL = env.BLOCKFROST_URL ?? "https://cardano-preprod.blockfrost.io/api/v0";
const lucid = await Lucid(new Blockfrost(URL, env.BLOCKFROST_KEY), "Preprod");
const protocol = buildProtocol(manifest.settingsPolicy);

// Every wallet we can sign with, including the accountIndex-1 wallets the P2
// examples used.
const wallets = {};
for (const name of ["USER1", "USER2", "ADMIN"]) {
  const seed = env[`${name}_SEED`];
  if (!seed) continue;
  for (const idx of [0, 1]) {
    lucid.selectWallet.fromSeed(seed, { accountIndex: idx });
    const addr = await lucid.wallet().address();
    wallets[paymentCredentialOf(addr).hash] = `${name}#${idx}`;
    wallets[addr] = `${name}#${idx}`;
  }
}
const who = (x) => wallets[x] ?? `UNKNOWN(${String(x).slice(0, 22)}…)`;

const treasuryAddress = Effect.runSync(
  getScriptAddress(lucid, protocol.treasuryValidator.spendTreasury),
);
console.log("treasury address", treasuryAddress);

const utxos = await lucid.utxosAt(treasuryAddress);
console.log(`treasury UTxOs: ${utxos.length}\n`);

// account suffix → holder, from the 222 tokens
const holderOf = async (suffix) => {
  try {
    const u = await lucid.utxoByUnit(
      accountPolicyId + suffix,
    );
    return who(u.address);
  } catch (e) {
    return `?? ${String(e).slice(0, 50)}`;
  }
};

const byGroup = {};
for (const u of utxos) {
  const parsed = await Effect.runPromise(
    Effect.either(parseSafeDatum(u.datum, TreasuryDatumSchema)),
  );
  if (parsed._tag !== "Right") {
    console.log(`  undecodable ${u.txHash.slice(0, 12)}#${u.outputIndex}`);
    continue;
  }
  const d = parsed.right;
  const variant = Object.keys(d)[0];
  const body = d[variant];
  const gid = body.group_reference_tokenname ?? "(reserve/none)";
  (byGroup[gid] ??= []).push({ u, variant, body });
}

for (const [gid, entries] of Object.entries(byGroup)) {
  let head = `\n=== group ${gid}`;
  try {
    const gu = await lucid.utxoByUnit(
      protocol.groupPolicyId + gid,
    );
    const g = Data.from(gu.datum, GroupCip68Datum).extra;
    head += `  "${Buffer.from(g.group_name ?? "", "hex").toString()}" active=${g.is_active} started=${g.is_started} members=${g.member_count}/${g.max_members} activeMembers=${g.active_member_count} rounds=${g.num_rounds} interval=${g.interval_length} start=${new Date(Number(g.start_time)).toISOString()}`;
    head += `\n    creator=${who(g.creator?.VerificationKey?.[0] ?? g.creator)} bond=${Number(g.creator_bond) / 1e6} contribution=${Number(g.contribution_amount) / 1e6}`;
  } catch (e) {
    head += `  (no group anchor: ${String(e).slice(0, 60)})`;
  }
  console.log(head);
  for (const { u, variant, body } of entries) {
    const suffix = body.member_reference_tokenname;
    const holder = suffix ? await holderOf(suffix) : "-";
    console.log(
      `  ${variant.padEnd(14)} ada=${(Number(u.assets.lovelace) / 1e6).toFixed(2).padStart(8)}  rounds_paid=${body.rounds_paid ?? "-"}  claimable=${body.claimable_balance ?? "-"}  member=${(suffix ?? "-").slice(0, 12)}…  holder=${holder}  memberCred=${body.member_payment_credential ? who(body.member_payment_credential) : "-"}`,
    );
  }
}
