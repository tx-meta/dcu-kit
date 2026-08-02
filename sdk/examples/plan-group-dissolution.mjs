/**
 * Read-only dissolution planner.
 *
 * For every live group under the group policy, prints the group datum, every
 * treasury UTxO bound to it (with its decoded state), and which of our wallets
 * holds each member account (222) token — so the close-out sequence per group
 * can be derived from chain state instead of guessed.
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
import { makeLucid } from "./dist/context.js";
import { loadSdk } from "./dist/sdk.js";
import { loadState } from "./dist/state.js";

const j = (x) =>
  JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const state = loadState();
const policy = state.groupPolicyId;
const { lucid } = await makeLucid();
const sdk = loadSdk();

// Map every wallet we control to its address, so treasury member tokens can be
// attributed to a signer rather than an anonymous credential.
const wallets = {};
for (const name of ["ADMIN", "USER1", "USER2"]) {
  const seed = process.env[`${name}_SEED`];
  if (!seed) continue;
  lucid.selectWallet.fromSeed(seed);
  wallets[await lucid.wallet().address()] = name;
}
const who = (addr) => wallets[addr] ?? `EXTERNAL(${addr.slice(0, 24)}…)`;

// Which wallet holds which account (222) token.
const accountHolder = {};
for (const [addr, name] of Object.entries(wallets)) {
  for (const u of await lucid.utxosAt(addr)) {
    for (const k of Object.keys(u.assets)) {
      if (
        k.startsWith(accountPolicyId) &&
        k.slice(accountPolicyId.length).startsWith(assetNameLabels.prefix222)
      ) {
        accountHolder[
          k.slice(accountPolicyId.length + assetNameLabels.prefix222.length)
        ] = name;
      }
    }
  }
}
console.log("account(222) tokens held by our wallets:", j(accountHolder), "\n");

const res = await fetch(
  `https://cardano-preprod.blockfrost.io/api/v0/assets/policy/${policy}?count=100`,
  { headers: { project_id: process.env.BLOCKFROST_KEY } },
);
const suffixes = [
  ...new Set(
    (await res.json())
      .filter((a) => a.quantity !== "0")
      .map((a) => a.asset.slice(56))
      .filter((n) => n.startsWith(assetNameLabels.prefix100))
      .map((n) => n.slice(assetNameLabels.prefix100.length)),
  ),
];

const tAddr = await Effect.runPromise(
  getScriptAddress(lucid, sdk.protocol.treasuryValidator.spendTreasury),
);
const allTreasury = await lucid.utxosAt(tAddr);
console.log(`treasury UTxOs total: ${allTreasury.length}\n`);

for (const suffix of suffixes) {
  const groupUtxo = await lucid.utxoByUnit(
    policy + assetNameLabels.prefix100 + suffix,
  );
  const d = Data.from(groupUtxo.datum, GroupCip68Datum).extra;
  console.log(`=== GROUP ${suffix} ===`);
  console.log(
    j({
      is_active: d.is_active,
      is_started: d.is_started,
      member_count: d.member_count,
      active_member_count: d.active_member_count,
      num_rounds: d.num_rounds,
      last_distributed_round: d.last_distributed_round,
      payout_mode: d.payout_mode,
      penalty_fee: d.penalty_fee,
      contribution_fee: d.contribution_fee,
      creator_bond: d.creator_bond,
      start_time: d.start_time,
      interval_length: d.interval_length,
      member_token_names: d.member_token_names,
    }),
  );
  const adminUtxo = await lucid
    .utxoByUnit(policy + assetNameLabels.prefix222 + suffix)
    .catch(() => null);
  console.log("admin(222) holder:", adminUtxo ? who(adminUtxo.address) : "?");

  // Treasury UTxOs whose datum names this group.
  for (const u of allTreasury) {
    let td;
    try {
      td = await Effect.runPromise(parseSafeDatum(u.datum, TreasuryDatumSchema));
    } catch {
      continue;
    }
    const inner = Object.values(td)[0];
    // Token names carry a CIP-68 label prefix; compare on the 28-byte unique part.
    const bare = (n) => (n && n.length > 56 ? n.slice(n.length - 56) : n);
    if (bare(inner.group_reference_tokenname) !== suffix) continue;
    const kind = Object.keys(td)[0];
    const member = bare(inner.member_reference_tokenname);
    console.log(
      `  [${kind}] ${u.txHash.slice(0, 12)}#${u.outputIndex} ada=${
        Number(u.assets.lovelace) / 1e6
      } member=${member ? member.slice(0, 12) + "…" : "-"} holder=${
        member ? (accountHolder[member] ?? "NOT-IN-OUR-WALLETS") : "-"
      } ${j(inner)}`,
    );
  }
  console.log("");
}
