/**
 * P2 matrix B14 (middle part): actions inside the OPEN recommit window.
 *
 * On the recommit group, while the window opened by begin-recommit is open:
 *  1. free exit — member `924fe76f…` leaves with no penalty;
 *  2. window join — spare account `34bca0e7…` joins (recommit re-opens
 *     joining), restoring member_count=2 so tomorrow's re-seal (start-group
 *     requires >= 2 members) can run.
 *
 * Both accounts live in the ADMIN wallet. Appends to
 * evidence/p2-recommit-lap.json. Run once while the window is open.
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

const GROUP = "cb57d564125ecb8e41b8da8127bbc05193ef4aaddfffee6a67234648";
const EXITER = "924fe76f89d13594b0d671d92c51dda4b74b56c85a716220eb566096";
const JOINER = "34bca0e737ddea7292a31a95aa042b19910f4afc64aab1c3e8a1766b";

async function main() {
  const lucid = await Lucid(
    new Blockfrost(process.env.BLOCKFROST_URL!, process.env.BLOCKFROST_KEY!),
    "Preprod",
  );
  lucid.selectWallet.fromSeed(process.env.ADMIN_SEED!);
  const state = loadState();
  const dcu = createDcuSession(lucid, state.settingsPolicy!);
  const scriptRefs = await loadScriptRefs(lucid);
  const groupUnit = state.groupPolicyId! + assetNameLabels.prefix100 + GROUP;

  const groupState = async () => {
    const u = patchInlineDatum(await lucid.utxoByUnit(groupUnit));
    const d = await Effect.runPromise(parseGroupCip68Datum(u.datum!));
    return { txHash: u.txHash, count: d.groupDatum.member_count };
  };

  const step = async (
    label: string,
    runner: { unsafeRun: () => Promise<any> },
  ) => {
    const before = await groupState();
    const built = await runner.unsafeRun();
    const tx = built.tx ?? built;
    const signed = await tx.sign.withWallet().complete();
    const h = await signed.submit();
    await lucid.awaitTx(h);
    for (let i = 0; i < 30; i++) {
      const now = await groupState();
      if (now.txHash !== before.txHash) break;
      await sleep(6000);
    }
    for (let i = 0; i < 30; i++) {
      const w = await lucid.wallet().getUtxos();
      if (w.some((u) => u.txHash === h)) break;
      await sleep(6000);
    }
    await sleep(4000);
    console.log(`  ✓ ${label}: ${cexplorerTxUrl(h)}`);
    return h;
  };

  let g = await groupState();
  console.log(`recommit group member_count=${g.count} (window open)`);

  const exitTx = await step(
    "B14 free exit during window (924fe76f…)",
    dcu.exitGroup({
      groupTokenSuffix: GROUP,
      accountTokenSuffix: EXITER,
      scriptRefs,
    }),
  );
  const joinTx = await step(
    "B14 window join (34bca0e7…)",
    dcu.joinGroup({
      groupTokenSuffix: GROUP,
      accountTokenSuffix: JOINER,
      scriptRefs,
    }),
  );

  g = await groupState();
  console.log(`member_count after window actions: ${g.count}`);

  const p = path.join(__dirname, "evidence", "p2-recommit-lap.json");
  const ev = JSON.parse(fs.readFileSync(p, "utf8"));
  ev.windowActions = {
    freeExitTx: exitTx,
    windowJoinTx: joinTx,
    memberCountAfter: g.count.toString(),
    capturedAt: new Date().toISOString(),
  };
  fs.writeFileSync(p, JSON.stringify(ev, null, 2) + "\n");
  console.log(
    "\nWindow actions recorded. Re-seal tomorrow >= 2026-07-18T12:21:02Z.",
  );
}

main().catch((e) => {
  console.error(String(e).slice(0, 600));
  process.exit(1);
});
