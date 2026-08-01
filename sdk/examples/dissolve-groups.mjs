/**
 * Dissolve every live ROSCA group left over from the P2 rehearsal.
 *
 * Resumable by construction: each pass re-reads chain state, performs exactly one
 * action, waits for confirmation, then re-reads. Interrupt it at any point and
 * re-run — it picks up from whatever the chain actually shows.
 *
 * Order per group (deactivate FIRST so every exit takes the free/mature path):
 *   1. cancel any pending RecoveryRequest      (as the target member)
 *   2. updateGroup is_active: true → false     (admin; one-way latch)
 *   3. exitGroup   for each TreasuryState      (as the token holder; free once inactive)
 *      terminateDefault for each DefaultState  (admin; grace already expired)
 *      terminateGroup   for each PenaltyState  (admin; claims forfeited collateral)
 *   4. deleteGroup once member_count === 0     (admin; burns 100+222, closes reserve)
 *
 * Usage:  node dissolve-groups.mjs [groupSuffix ...]     (default: all live groups)
 */
import { Data } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  GroupCip68Datum,
  assetNameLabels,
  parseSafeDatum,
  TreasuryDatumSchema,
  getScriptAddress,
  accountPolicyId,
} from "@tx-meta/dcu-kit";
import { makeLucid, loadScriptRefs, cexplorerTxUrl } from "./dist/context.js";
import { loadSdk } from "./dist/sdk.js";
import { loadState } from "./dist/state.js";

const j = (x) =>
  JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Blockfrost needs ~60s to index a spend; without this the next pass reads stale UTxOs. */
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 75_000);
/** CIP-68 token names carry a 4-byte label; compare on the 28-byte unique part. */
const bare = (n) => (n && n.length > 56 ? n.slice(n.length - 56) : n);

const state = loadState();
const policy = state.groupPolicyId;
const { lucid } = await makeLucid();
const sdk = loadSdk();
const scriptRefs = await loadScriptRefs(lucid);

const SEEDS = {};
for (const name of ["ADMIN", "USER1", "USER2"]) {
  if (process.env[`${name}_SEED`]) SEEDS[name] = process.env[`${name}_SEED`];
}
const use = (name) => {
  if (!SEEDS[name]) throw new Error(`${name}_SEED not set`);
  lucid.selectWallet.fromSeed(SEEDS[name]);
  return name;
};

/** Which of our wallets holds each account (222) token, re-read on demand. */
async function accountHolders() {
  const map = {};
  for (const name of Object.keys(SEEDS)) {
    use(name);
    for (const u of await lucid.wallet().getUtxos()) {
      for (const k of Object.keys(u.assets)) {
        if (
          k.startsWith(accountPolicyId) &&
          k.slice(accountPolicyId.length).startsWith(assetNameLabels.prefix222)
        ) {
          map[
            k.slice(accountPolicyId.length + assetNameLabels.prefix222.length)
          ] = name;
        }
      }
    }
  }
  return map;
}

async function submit(label, tx) {
  console.log(`  → ${label}: signing…`);
  const signed = await tx.sign.withWallet().complete();
  const hash = await signed.submit();
  console.log(`  → ${label}: ${hash}`);
  console.log(`    ${cexplorerTxUrl(hash)}`);
  await lucid.awaitTx(hash);
  console.log(`  → confirmed; settling ${SETTLE_MS / 1000}s for indexing…`);
  await sleep(SETTLE_MS);
  return hash;
}

async function liveSuffixes() {
  const res = await fetch(
    `https://cardano-preprod.blockfrost.io/api/v0/assets/policy/${policy}?count=100`,
    { headers: { project_id: process.env.BLOCKFROST_KEY } },
  );
  return [
    ...new Set(
      (await res.json())
        .filter((a) => a.quantity !== "0")
        .map((a) => a.asset.slice(56))
        .filter((n) => n.startsWith(assetNameLabels.prefix100))
        .map((n) => n.slice(assetNameLabels.prefix100.length)),
    ),
  ];
}

/** Treasury UTxOs bound to a group, decoded. */
async function treasuryFor(suffix) {
  const tAddr = await Effect.runPromise(
    getScriptAddress(lucid, sdk.protocol.treasuryValidator.spendTreasury),
  );
  const out = [];
  for (const u of await lucid.utxosAt(tAddr)) {
    let td;
    try {
      td = await Effect.runPromise(parseSafeDatum(u.datum, TreasuryDatumSchema));
    } catch {
      continue;
    }
    const kind = Object.keys(td)[0];
    const inner = Object.values(td)[0];
    if (bare(inner.group_reference_tokenname) !== suffix) continue;
    out.push({ utxo: u, kind, inner });
  }
  return out;
}

/**
 * One action for one group. Returns true if it acted (caller should re-read),
 * false if the group is fully dissolved.
 */
async function step(suffix, holders) {
  const groupUtxo = await lucid
    .utxoByUnit(policy + assetNameLabels.prefix100 + suffix)
    .catch(() => null);
  if (!groupUtxo) {
    console.log(`  group token gone — dissolved.`);
    return false;
  }
  const g = Data.from(groupUtxo.datum, GroupCip68Datum).extra;
  const t = await treasuryFor(suffix);
  console.log(
    `  state: ${j({ is_active: g.is_active, member_count: g.member_count, active: g.active_member_count })} treasury=[${t.map((x) => x.kind).join(",")}]`,
  );

  // 1. Pending recovery request — veto it so no ghost treasury token is stranded.
  const rec = t.find((x) => x.kind === "RecoveryRequest");
  if (rec) {
    const target = bare(rec.inner.target_token);
    const holder = holders[target];
    if (!holder)
      throw new Error(`RecoveryRequest target ${target} not in our wallets`);
    use(holder);
    console.log(`  cancel-recovery as ${holder}`);
    await submit(
      "cancelRecovery",
      await sdk
        .cancelRecovery(lucid, {
          targetTokenSuffix: target,
          newAccountTokenSuffix: bare(rec.inner.new_member_tokenname),
          scriptRefs,
        })
        .unsafeRun(),
    );
    return true;
  }

  // 2. Deactivate first — makes every subsequent exit penalty-free (mature path).
  if (g.is_active) {
    use("ADMIN");
    console.log(`  deactivating (is_active true → false)`);
    await submit(
      "updateGroup",
      await sdk
        .updateGroup(lucid, {
          groupTokenSuffix: suffix,
          updatedDatum: { ...g, is_active: false },
        })
        .unsafeRun(),
    );
    return true;
  }

  // 3. Drain members, one per pass.
  const pen = t.find((x) => x.kind === "PenaltyState");
  if (pen) {
    use("ADMIN");
    console.log(`  terminate-group (claim penalty)`);
    await submit(
      "terminateGroup",
      await sdk
        .terminateGroup(lucid, {
          groupTokenSuffix: suffix,
          memberAccountTokenSuffix: bare(pen.inner.member_reference_tokenname),
          scriptRefs,
        })
        .unsafeRun(),
    );
    return true;
  }

  const def = t.find((x) => x.kind === "DefaultState");
  if (def) {
    use("ADMIN");
    console.log(
      `  terminate-default (grace expired ${new Date(Number(def.inner.grace_expires_at)).toISOString()})`,
    );
    await submit(
      "terminateDefault",
      await sdk
        .terminateDefault(lucid, {
          groupTokenSuffix: suffix,
          memberAccountTokenSuffix: bare(def.inner.member_reference_tokenname),
          scriptRefs,
        })
        .unsafeRun(),
    );
    return true;
  }

  const mem = t.find((x) => x.kind === "TreasuryState");
  if (mem) {
    const acct = bare(mem.inner.member_reference_tokenname);
    const holder = holders[acct];
    if (!holder)
      throw new Error(`member account ${acct} not held by our wallets`);
    use(holder);
    console.log(`  exit-group as ${holder} (account ${acct.slice(0, 12)}…)`);
    await submit(
      "exitGroup",
      await sdk
        .exitGroup(lucid, {
          groupTokenSuffix: suffix,
          accountTokenSuffix: acct,
          scriptRefs,
        })
        .unsafeRun(),
    );
    return true;
  }

  // 4. Empty and inactive — dissolve.
  if (g.member_count === 0n) {
    use("ADMIN");
    console.log(`  delete-group`);
    await submit(
      "deleteGroup",
      await sdk
        .deleteGroup(lucid, { groupTokenSuffix: suffix, scriptRefs })
        .unsafeRun(),
    );
    return true;
  }

  throw new Error(
    `stuck: member_count=${g.member_count} but no member treasury UTxO found`,
  );
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : await liveSuffixes();
console.log(`dissolving ${targets.length} group(s)\n`);

const results = [];
for (const suffix of targets) {
  console.log(`=== ${suffix} ===`);
  try {
    for (let i = 0; i < 12; i++) {
      const holders = await accountHolders();
      if (!(await step(suffix, holders))) break;
    }
    results.push([suffix, "OK"]);
  } catch (e) {
    console.error(`  FAILED: ${String(e).slice(0, 400)}`);
    results.push([suffix, `FAILED: ${String(e).slice(0, 120)}`]);
  }
  console.log("");
}

console.log("=== SUMMARY ===");
for (const [s, r] of results) console.log(`${s.slice(0, 12)}…  ${r}`);
