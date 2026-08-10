/**
 * Read-only Preprod inventory across every module.
 *
 * Enumerates each module policy on Blockfrost, keeps the assets whose quantity
 * is still non-zero, and decodes the live object behind each one, so the state
 * a UI renders can be listed from the chain instead of from local state files.
 *
 * Usage: from sdk/, `npx tsx examples/inspect-preprod-inventory.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost, Data } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  buildProtocol,
  accountPolicyId,
  assetNameLabels,
  GroupCip68Datum,
} from "../src/index.js";
import { savingsPolicyId } from "../src/savings/validators.js";
import { getFundStateProgram } from "../src/savings/queries/getFundState.js";
import { getFundMembersProgram } from "../src/savings/queries/getFundMembers.js";
import { getFundLoansProgram } from "../src/savings/queries/getFundLoans.js";
import {
  escrowV2PolicyId,
  poolPolicyId,
  projectPolicyId,
} from "../src/escrow/v2/validators.js";
import { escrowPolicyId } from "../src/escrow/validators.js";
import { getEscrowStateProgram as getEscrowV1StateProgram } from "../src/escrow/queries/getEscrowState.js";
import { getPoolStateProgram } from "../src/escrow/v2/queries/getPoolState.js";
import { getEscrowStateProgram } from "../src/escrow/v2/queries/getEscrowState.js";
import { getProjectStateProgram } from "../src/escrow/v2/queries/getProjectState.js";
import { buildGovernance } from "../src/governance/validators.js";
import { getProposalsProgram } from "../src/governance/queries/getProposals.js";
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

const bf = async (path) => {
  const r = await fetch(`${URL}${path}`, {
    headers: { project_id: env.BLOCKFROST_KEY },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
};

/** Every asset of a policy whose quantity is still non-zero. */
const liveAssets = async (policy) => {
  const out = [];
  for (let page = 1; page < 20; page++) {
    const res = await bf(`/assets/policy/${policy}?count=100&page=${page}`);
    if (!res.length) break;
    out.push(...res);
    if (res.length < 100) break;
  }
  return out.filter((a) => a.quantity !== "0");
};

const j = (x) =>
  JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const run = (p) => Effect.runPromise(Effect.either(p));
const show = (r) => (r._tag === "Right" ? j(r.right) : `ERR ${String(r.left).slice(0, 120)}`);

const protocol = buildProtocol(manifest.settingsPolicy);
const gov = buildGovernance(manifest.governance.seed);

const strip = (name, prefix) => name.slice(prefix.length);

// ─── ROSCA groups ───────────────────────────────────────────────────────────
console.log("\n########## ROSCA groups  policy", protocol.groupPolicyId);
const groupAssets = await liveAssets(protocol.groupPolicyId);
const groupSuffixes = [
  ...new Set(
    groupAssets
      .map((a) => a.asset.slice(56))
      .filter((n) => n.startsWith(assetNameLabels.prefix100))
      .map((n) => strip(n, assetNameLabels.prefix100)),
  ),
];
console.log(`live groups: ${groupSuffixes.length}`);
for (const s of groupSuffixes) {
  try {
    const u = await lucid.utxoByUnit(
      protocol.groupPolicyId + assetNameLabels.prefix100 + s,
    );
    const d = Data.from(u.datum, GroupCip68Datum).extra;
    console.log(
      `  ${s}  active=${d.is_active} started=${d.is_started} members=${d.member_count} activeMembers=${d.active_member_count} round=${d.round_number}/${d.num_rounds} bond=${Number(d.creator_bond) / 1e6}`,
    );
  } catch (e) {
    console.log(`  ${s}  ERROR ${String(e).slice(0, 100)}`);
  }
}

// ─── ROSCA treasuries ───────────────────────────────────────────────────────
const treasuryAssets = await liveAssets(protocol.treasuryPolicyId);
console.log(
  `\n########## ROSCA treasury tokens  policy ${protocol.treasuryPolicyId}  live=${treasuryAssets.length}`,
);
for (const a of treasuryAssets) {
  const name = a.asset.slice(56);
  try {
    const u = await lucid.utxoByUnit(a.asset);
    console.log(
      `  ${name.slice(0, 24)}…  @${u.address.slice(0, 22)}…  ada=${(Number(u.assets.lovelace) / 1e6).toFixed(2)}`,
    );
  } catch (e) {
    console.log(`  ${name.slice(0, 24)}…  ERROR ${String(e).slice(0, 80)}`);
  }
}

// ─── Member accounts ────────────────────────────────────────────────────────
const accountAssets = await liveAssets(accountPolicyId);
const accountSuffixes = [
  ...new Set(
    accountAssets
      .map((a) => a.asset.slice(56))
      .filter((n) => n.startsWith(assetNameLabels.prefix100))
      .map((n) => strip(n, assetNameLabels.prefix100)),
  ),
];
console.log(
  `\n########## Member accounts  policy ${accountPolicyId}  live=${accountSuffixes.length}`,
);
for (const s of accountSuffixes) {
  try {
    const u = await lucid.utxoByUnit(
      accountPolicyId + assetNameLabels.prefix222 + s,
    );
    console.log(`  ${s}  holder=${u.address.slice(0, 26)}…`);
  } catch (e) {
    console.log(`  ${s}  222-token ERROR ${String(e).slice(0, 70)}`);
  }
}

// ─── Savings funds ──────────────────────────────────────────────────────────
console.log("\n########## Savings  policy", savingsPolicyId);
const savingsAssets = await liveAssets(savingsPolicyId);
for (const a of savingsAssets) {
  const name = a.asset.slice(56);
  const kind = name.startsWith(assetNameLabels.prefix100)
    ? "member-ref"
    : name.startsWith(assetNameLabels.prefix222)
      ? "member-own"
      : "fund-anchor";
  console.log(`  [${kind}] ${name}`);
  if (kind !== "fund-anchor") continue;
  const st = await run(getFundStateProgram(lucid, name));
  console.log(`     state: ${show(st)}`);
  const mem = await run(getFundMembersProgram(lucid, name));
  console.log(`     members: ${show(mem)}`);
  const loans = await run(getFundLoansProgram(lucid, name));
  console.log(`     loans: ${show(loans)}`);
}

// ─── Fundraising pools ──────────────────────────────────────────────────────
console.log("\n########## Pools  policy", poolPolicyId);
for (const a of await liveAssets(poolPolicyId)) {
  const name = a.asset.slice(56);
  const st = await run(getPoolStateProgram(lucid, { poolTokenName: name }));
  console.log(`  ${name}\n     ${show(st)}`);
}

// ─── Escrows v1 ─────────────────────────────────────────────────────────────
// v1 is a SEPARATE policy from v2 and is the generation Kyama integrated
// against, so a sweep that checks only v2 reports a false all-clear.
console.log("\n########## Escrow v1  policy", escrowPolicyId);
for (const a of await liveAssets(escrowPolicyId)) {
  const name = a.asset.slice(56);
  const st = await run(getEscrowV1StateProgram(lucid, { stateTokenName: name }));
  if (st._tag !== "Right") {
    console.log(`  ${name}\n     ${show(st)}`);
    continue;
  }
  const s = st.right;
  console.log(
    `  ${name}\n     released=${s.releasedCount}/${s.totalMilestones} remaining=${s.remainingBalance} expiry=${new Date(Number(s.expiry)).toISOString()} expired=${s.expired}`,
  );
  console.log(
    `     funder=${j(s.datum.funder.payment_credential)} beneficiary=${j(s.datum.beneficiary.payment_credential)}`,
  );
}

// ─── Escrows v2 ─────────────────────────────────────────────────────────────
console.log("\n########## Escrow v2  policy", escrowV2PolicyId);
for (const a of await liveAssets(escrowV2PolicyId)) {
  const name = a.asset.slice(56);
  const st = await run(getEscrowStateProgram(lucid, { stateTokenName: name }));
  console.log(`  ${name}\n     ${show(st)}`);
}

// ─── Projects ───────────────────────────────────────────────────────────────
console.log("\n########## Projects  policy", projectPolicyId);
for (const a of await liveAssets(projectPolicyId)) {
  const name = a.asset.slice(56);
  const st = await run(getProjectStateProgram(lucid, { projectTokenName: name }));
  console.log(`  ${name}\n     ${show(st)}`);
}

// ─── Governance ─────────────────────────────────────────────────────────────
console.log("\n########## Governance  govPolicy", gov.govPolicy);
const props = await run(getProposalsProgram(lucid, gov));
if (props._tag !== "Right") {
  console.log(`  ERR ${String(props.left).slice(0, 200)}`);
} else {
  console.log(`  live proposals: ${props.right.length}`);
  for (const p of props.right) {
    console.log(`   - ${p.proposalId}\n     ${j(p.proposal)}`);
  }
}
const govAssets = await liveAssets(gov.govPolicy);
console.log(`  gov tokens live: ${govAssets.length}`);
for (const a of govAssets) {
  const name = a.asset.slice(56);
  try {
    const u = await lucid.utxoByUnit(a.asset);
    console.log(
      `   - ${name.slice(0, 20)}…  @${u.address.slice(0, 24)}…  ada=${(Number(u.assets.lovelace) / 1e6).toFixed(2)}`,
    );
  } catch (e) {
    console.log(`   - ${name.slice(0, 20)}…  ERROR ${String(e).slice(0, 70)}`);
  }
}
