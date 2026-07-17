/**
 * P2 recommit rotation lap + begin-recommit + C8 premature re-seal.
 *
 * On the recommit group (both member accounts in the ADMIN wallet):
 *  1. distribute round 0 (join deposits fund it)          — matrix B10
 *  2. contribute one round for both members               — matrix B9
 *  3. distribute round 1 (lap boundary reached)           — matrix B10
 *  4. begin-recommit (opens the free-exit window)         — part of B14
 *  5. C8: attempt the re-seal (start-group) NOW — the window is open and
 *     start_time + recommit_window is tomorrow, so the validator must
 *     reject; captured as a rejection record, never submitted.
 *
 * Env: GROUP, ACCOUNT_A, ACCOUNT_B. Appends to evidence/p2-recommit-lap.json.
 */

import "dotenv/config";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import {
  createDcuSdk,
  createDcuSession,
  assetNameLabels,
  parseGroupCip68Datum,
  patchInlineDatum,
} from "@tx-meta/dcu-kit";
import {
  captureRejection,
  deploymentIdentity,
  RejectionEvidence,
} from "@tx-meta/dcu-kit/harness";
import { Effect } from "effect";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadState } from "./state.js";
import { loadScriptRefs, cexplorerTxUrl } from "./context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "evidence", "p2-recommit-lap.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const key = process.env.BLOCKFROST_KEY!;
  const url = process.env.BLOCKFROST_URL!;
  const groupSuffix = process.env.GROUP!;
  const accounts = [process.env.ACCOUNT_A!, process.env.ACCOUNT_B!];
  const lucid = await Lucid(new Blockfrost(url, key), "Preprod");
  lucid.selectWallet.fromSeed(process.env.ADMIN_SEED!);

  const state = loadState();
  const dcu = createDcuSession(lucid, state.settingsPolicy!);
  const scriptRefs = await loadScriptRefs(lucid);
  const groupUnit =
    state.groupPolicyId! + assetNameLabels.prefix100 + groupSuffix;
  const out: Record<string, unknown>[] = [];

  const groupState = async () => {
    const u = patchInlineDatum(await lucid.utxoByUnit(groupUnit));
    const d = await Effect.runPromise(parseGroupCip68Datum(u.datum!));
    return { txHash: u.txHash, d: d.groupDatum };
  };

  // Wait until the group UTxO advances past `fromTxid` AND the wallet sees the
  // submitted tx (script-state + wallet indexing both lag on Blockfrost).
  const submitAndAdvance = async (
    label: string,
    program: { unsafeRun: () => Promise<any> },
    expectGroupMove: boolean,
  ) => {
    const before = await groupState();
    const built = await program.unsafeRun();
    const tx = built.tx ?? built;
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    await lucid.awaitTx(txHash);
    if (expectGroupMove) {
      for (let i = 0; i < 30; i++) {
        const now = await groupState();
        if (now.txHash !== before.txHash) break;
        await sleep(6000);
      }
    }
    for (let i = 0; i < 30; i++) {
      const utxos = await lucid.wallet().getUtxos();
      if (utxos.some((u) => u.txHash === txHash)) break;
      await sleep(6000);
    }
    await sleep(4000);
    console.log(`  ✓ ${label}: ${cexplorerTxUrl(txHash)}`);
    out.push({ step: label, txHash });
    return txHash;
  };

  let g = await groupState();
  console.log(
    `group ${groupSuffix.slice(0, 8)}… last_distributed_round=${g.d.last_distributed_round} era_start=${g.d.era_start_round}`,
  );

  // 1. distribute round 0 (funded by the join deposits)
  if (g.d.last_distributed_round < 0n) {
    await submitAndAdvance(
      "B10 distribute round 0",
      dcu.distributePayout({ groupTokenSuffix: groupSuffix, scriptRefs }),
      true,
    );
  }

  // 2. contribute one round for both members (funds round 1)
  for (const acct of accounts) {
    await submitAndAdvance(
      `B9 contribute (${acct.slice(0, 8)}…)`,
      dcu.contribute({
        groupTokenSuffix: groupSuffix,
        accountTokenSuffix: acct,
        topUpAmount: 5_000_000n,
        scriptRefs,
      }),
      false,
    );
  }

  // 3. distribute round 1 → lap boundary
  g = await groupState();
  if (g.d.last_distributed_round < 1n) {
    await submitAndAdvance(
      "B10 distribute round 1 (lap boundary)",
      dcu.distributePayout({ groupTokenSuffix: groupSuffix, scriptRefs }),
      true,
    );
  }

  // 4. begin-recommit (createDcuSession lacks beginRecommit — session API gap,
  //    noted for the ergonomics backlog; the sdk-level binding has it)
  const sdkLevel = createDcuSdk(state.settingsPolicy!);
  await submitAndAdvance(
    "B14 begin-recommit (window opens)",
    sdkLevel.beginRecommit(lucid, {
      groupTokenSuffix: groupSuffix,
      scriptRefs,
    }),
    true,
  );

  // 5. C8 premature re-seal: start_time + recommit_window is tomorrow, so the
  //    validator must reject this build. Never signed, never submitted.
  const evidence: RejectionEvidence = await Effect.runPromise(
    captureRejection(
      lucid,
      {
        label:
          "C8 premature re-seal (recommit window open, before start_time+window)",
        deployment: deploymentIdentity(dcu.protocol, "Preprod"),
        evaluation: "local-uplc",
      },
      dcu.startGroup({ groupTokenSuffix: groupSuffix, scriptRefs }).program(),
    ),
  );
  console.log(`  ✓ ${evidence.label} — rejected, evidence captured`);
  out.push({ step: "C8", evidence });

  const final = await groupState();
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        group: groupSuffix,
        steps: out,
        finalDatum: {
          last_distributed_round: final.d.last_distributed_round.toString(),
          era_start_round: final.d.era_start_round.toString(),
          is_started: final.d.is_started,
        },
        capturedAt: new Date().toISOString(),
      },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
  console.log(
    "\nLap + begin-recommit + C8 complete →",
    path.relative(process.cwd(), OUT),
  );
}

main().catch((e) => {
  console.error(String(e).slice(0, 600));
  process.exit(1);
});
