/**
 * Ad-hoc inspector: prints the live group datum + every treasury UTxO for the
 * current group in state.json. Read-only.
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
} from "@tx-meta/dcu-sdk";

const j = (x: unknown) =>
  JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function main() {
  const { lucid } = await makeLucid();
  const sdk = loadSdk();
  const p = sdk.protocol;
  const st = loadState();

  const groupUnit =
    p.groupPolicyId + assetNameLabels.prefix100 + st.groupTokenSuffix;
  const groupUtxo = await lucid.utxoByUnit(groupUnit);
  const cip = await Effect.runPromise(parseGroupCip68Datum(groupUtxo.datum));
  const gd = cip.groupDatum;
  const meta = decodeGroupMetadata(cip.metadata);
  console.log("=== GROUP ===");
  console.log(j({ name: meta.name, description: meta.description }));
  console.log(
    j({
      member_count: gd.member_count,
      num_rounds: gd.num_rounds,
      is_started: gd.is_started,
      last_distributed_round: gd.last_distributed_round,
      start_time: gd.start_time,
      payout_mode: gd.payout_mode,
      member_token_names: gd.member_token_names,
    }),
  );

  const tAddr = await Effect.runPromise(
    getScriptAddress(lucid, p.treasuryValidator.spendTreasury),
  );
  const tUtxos = await lucid.utxosAt(tAddr);
  console.log(`\n=== TREASURY UTxOs at ${tAddr}: ${tUtxos.length} ===`);
  for (const u of tUtxos) {
    try {
      const d = await Effect.runPromise(
        parseSafeDatum(u.datum, TreasuryDatumSchema),
      );
      console.log(
        `\n[${u.txHash.slice(0, 12)}#${u.outputIndex}] ada=${u.assets.lovelace}`,
      );
      console.log(j(d));
    } catch (e) {
      console.log(`\n[${u.txHash.slice(0, 12)}#${u.outputIndex}] UNDECODABLE`, String(e));
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
