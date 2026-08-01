/**
 * Inspect every live group under the group policy and report whether it meets
 * the delete-group preconditions (is_active === false && member_count === 0).
 */
import { Data } from "@lucid-evolution/lucid";
import { GroupCip68Datum, assetNameLabels } from "@tx-meta/dcu-kit";
import { makeLucid } from "./dist/context.js";
import { loadState } from "./dist/state.js";

const state = loadState();
const policy = state.groupPolicyId;
const { lucid } = await makeLucid();

const KEY = process.env.BLOCKFROST_KEY;
const res = await fetch(
  `https://cardano-preprod.blockfrost.io/api/v0/assets/policy/${policy}?count=100`,
  { headers: { project_id: KEY } },
);
const assets = await res.json();

const suffixes = [
  ...new Set(
    assets
      .filter((a) => a.quantity !== "0")
      .map((a) => a.asset.slice(56))
      .filter((n) => n.startsWith(assetNameLabels.prefix100))
      .map((n) => n.slice(assetNameLabels.prefix100.length)),
  ),
];

console.log(`Live groups: ${suffixes.length}\n`);

for (const suffix of suffixes) {
  const refUnit = policy + assetNameLabels.prefix100 + suffix;
  const adminUnit = policy + assetNameLabels.prefix222 + suffix;
  let line = `${suffix.slice(0, 8)}…  `;
  try {
    const utxo = await lucid.utxoByUnit(refUnit);
    const d = Data.from(utxo.datum, GroupCip68Datum).extra;
    const deletable = d.is_active === false && d.member_count === 0n;
    line += `active=${String(d.is_active).padEnd(5)} started=${String(d.is_started).padEnd(5)} `;
    line += `members=${String(d.member_count).padEnd(3)} activeMembers=${String(d.active_member_count).padEnd(3)} `;
    line += `rounds=${String(d.num_rounds).padEnd(3)} bond=${(Number(d.creator_bond) / 1e6).toFixed(1)} `;
    line += deletable ? "→ DELETABLE" : "→ BLOCKED";
    // Who holds the admin (222) token?
    try {
      const a = await lucid.utxoByUnit(adminUnit);
      line += `  admin@${a.address.slice(0, 20)}…`;
    } catch {
      line += "  admin@NOT-FOUND";
    }
  } catch (e) {
    line += `ERROR ${String(e).slice(0, 90)}`;
  }
  console.log(line);
}
