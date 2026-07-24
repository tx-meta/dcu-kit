/**
 * P2 recommit-clock finisher: joins the remaining member to the partially-built
 * recommit group and starts it, anchoring start_time (the recommit clock).
 *
 * Handles the two live-network failure modes the first attempt hit:
 *  - validFrom drift: currentTime = Date.now() - 90s, so the tx lower bound is
 *    never ahead of the chain's current slot.
 *  - Blockfrost lag on the group UTxO: waits until the group's ref-token UTxO
 *    advances to the join's txid before building start-group.
 *
 * Env: GROUP=<suffix> ACCOUNT_B=<suffix>. Run once on Preprod.
 */

import "dotenv/config";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import {
  createDcuSession,
  assetNameLabels,
  parseGroupCip68Datum,
  patchInlineDatum,
} from "@tx-meta/dcu-kit";
import { Effect } from "effect";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadState } from "./state.js";
import { loadScriptRefs, cexplorerTxUrl } from "./context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DRIFT = 90_000n;

async function main() {
  const key = process.env.BLOCKFROST_KEY!;
  const url = process.env.BLOCKFROST_URL!;
  const groupSuffix = process.env.GROUP!;
  const accountB = process.env.ACCOUNT_B!;
  const lucid = await Lucid(new Blockfrost(url, key), "Preprod");
  lucid.selectWallet.fromSeed(process.env.ADMIN_SEED!);

  const state = loadState();
  const dcu = createDcuSession(lucid, state.settingsPolicy!);
  const scriptRefs = await loadScriptRefs(lucid);
  const groupUnit =
    state.groupPolicyId! + assetNameLabels.prefix100 + groupSuffix;

  const groupDatum = async () => {
    const u = patchInlineDatum(await lucid.utxoByUnit(groupUnit));
    const d = await Effect.runPromise(parseGroupCip68Datum(u.datum!));
    return { txHash: u.txHash, memberCount: d.groupDatum.member_count };
  };

  const waitGroupAdvances = async (fromTxid: string) => {
    for (let i = 0; i < 30; i++) {
      const g = await groupDatum();
      if (g.txHash !== fromTxid) return g;
      await sleep(6000);
    }
    throw new Error("group UTxO did not advance in time");
  };

  let g = await groupDatum();
  console.log(
    `group ${groupSuffix.slice(0, 8)}… member_count=${g.memberCount} at ${g.txHash.slice(0, 8)}…`,
  );

  if (g.memberCount < 2n) {
    const tx = await dcu
      .joinGroup({
        groupTokenSuffix: groupSuffix,
        accountTokenSuffix: accountB,
        currentTime: BigInt(Date.now()) - DRIFT,
        scriptRefs,
      })
      .unsafeRun();
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    await lucid.awaitTx(txHash);
    console.log(`  ✓ join member 1: ${cexplorerTxUrl(txHash)}`);
    g = await waitGroupAdvances(g.txHash);
    console.log(`  group advanced → member_count=${g.memberCount}`);
  }

  const stx = await dcu
    .startGroup({
      groupTokenSuffix: groupSuffix,
      currentTime: BigInt(Date.now()) - DRIFT,
      scriptRefs,
    })
    .unsafeRun();
  const ssigned = await stx.sign.withWallet().complete();
  const shash = await ssigned.submit();
  await lucid.awaitTx(shash);
  console.log(`  ✓ start-group: ${cexplorerTxUrl(shash)}`);

  const started = patchInlineDatum(await lucid.utxoByUnit(groupUnit));
  const sd = await Effect.runPromise(parseGroupCip68Datum(started.datum!));
  const out = {
    label: "P2 recommit group",
    groupTokenSuffix: groupSuffix,
    groupPolicyId: state.groupPolicyId,
    memberAccountSuffixes: [
      "1053643ca0010f8b45220eb77a2cc3f662b1a0aa96e78ee6c2415cdd",
      accountB,
    ],
    startTxHash: shash,
    startTimeMs: sd.groupDatum.start_time.toString(),
    startTimeIso: new Date(Number(sd.groupDatum.start_time)).toISOString(),
    numRounds: sd.groupDatum.num_rounds.toString(),
    recommitWindowMs: sd.groupDatum.recommit_window.toString(),
    reSealValidAtMs: (
      sd.groupDatum.start_time + sd.groupDatum.recommit_window
    ).toString(),
    reSealValidAtIso: new Date(
      Number(sd.groupDatum.start_time + sd.groupDatum.recommit_window),
    ).toISOString(),
    note: "Recommit clock = start_time. Run rotation lap + begin-recommit before re-seal, valid at reSealValidAt.",
  };
  fs.writeFileSync(
    path.join(__dirname, "evidence", "p2-recommit-state.json"),
    JSON.stringify(out, null, 2) + "\n",
  );
  console.log(
    "\nRecommit group started. start_time:",
    out.startTimeIso,
    "| re-seal valid:",
    out.reSealValidAtIso,
  );
}

main().catch((e) => {
  console.error(String(e).slice(0, 500));
  process.exit(1);
});
