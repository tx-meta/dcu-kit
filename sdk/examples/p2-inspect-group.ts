/**
 * Read-only P2 inspector: prints a group's live datum + every treasury UTxO
 * bound to it, for an arbitrary group suffix passed via GROUP_SUFFIX (falls back
 * to state.json). Does not touch state.json. Used during the day-2 matrix run to
 * inspect disposable/clock groups without churning the active state file.
 */
import { Effect } from "effect";
import { makeLucid } from "./context.js";
import { loadSdk } from "./sdk.js";
import { loadState } from "./state.js";
import {
  parseGroupCip68Datum,
  decodeGroupMetadata,
  parseSafeDatum,
  TreasuryDatumSchema,
  getScriptAddress,
  assetNameLabels,
} from "@tx-meta/dcu-kit";

const j = (x: unknown) =>
  JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function main() {
  const { lucid } = await makeLucid();
  const sdk = loadSdk();
  const p = sdk.protocol;
  const suffix = process.env.GROUP_SUFFIX ?? loadState().groupTokenSuffix;
  if (!suffix)
    throw new Error("GROUP_SUFFIX not set and no groupTokenSuffix in state.");

  const groupUnit = p.groupPolicyId + assetNameLabels.prefix100 + suffix;
  const groupUtxo = await lucid.utxoByUnit(groupUnit);
  const cip = await Effect.runPromise(parseGroupCip68Datum(groupUtxo.datum));
  const gd = cip.groupDatum;
  const meta = decodeGroupMetadata(cip.metadata);
  console.log("=== GROUP", suffix.slice(0, 12), "===");
  console.log("group UTxO:", groupUtxo.txHash + "#" + groupUtxo.outputIndex);
  console.log(j({ name: meta.name, description: meta.description }));
  console.log(
    j({
      member_count: gd.member_count,
      num_rounds: gd.num_rounds,
      is_started: gd.is_started,
      is_active: (gd as Record<string, unknown>).is_active,
      last_distributed_round: gd.last_distributed_round,
      start_time: gd.start_time,
      payout_mode: gd.payout_mode,
      member_token_names: gd.member_token_names,
    }),
  );
  // Who holds the group admin (222) token?
  const adminUnit = p.groupPolicyId + assetNameLabels.prefix222 + suffix;
  const adminUtxo = await lucid.utxoByUnit(adminUnit).catch(() => null);
  console.log(
    "\nadmin(222) at:",
    adminUtxo ? adminUtxo.address : "unresolved (multiple/none)",
  );

  const tAddr = await Effect.runPromise(
    getScriptAddress(lucid, p.treasuryValidator.spendTreasury),
  );
  const tUtxos = await lucid.utxosAt(tAddr);
  console.log(`\n=== TREASURY UTxOs at ${tAddr}: ${tUtxos.length} ===`);
  for (const u of tUtxos) {
    const memberTokens = Object.keys(u.assets).filter((k) => k !== "lovelace");
    try {
      const d = await Effect.runPromise(
        parseSafeDatum(u.datum, TreasuryDatumSchema),
      );
      console.log(
        `\n[${u.txHash.slice(0, 12)}#${u.outputIndex}] ada=${u.assets.lovelace} tokens=${memberTokens.map((t) => t.slice(-12)).join(",")}`,
      );
      console.log(j(d));
    } catch (e) {
      console.log(
        `\n[${u.txHash.slice(0, 12)}#${u.outputIndex}] ada=${u.assets.lovelace} UNDECODABLE`,
        String(e),
      );
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
