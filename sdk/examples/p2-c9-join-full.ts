/**
 * P2 matrix C9: join beyond max_members.
 *
 * Fills the pre-join fixture group (max_members=2): USER1's account joins,
 * USER2's account joins (group FULL), then ADMIN's account attempts a third
 * join — the validator must reject it at evaluation (captured, never
 * submitted). Also exercises joining-fee routing on the B6-updated config.
 *
 * Env: GROUP=<suffix>. Writes evidence/negative-proofs/C9-*.json + join txs
 * into evidence/p2-c9-joins.json.
 */

import "dotenv/config";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import {
  createDcuSession,
  assetNameLabels,
  parseGroupCip68Datum,
  patchInlineDatum,
} from "@tx-meta/dcu-kit";
import { captureRejection, deploymentIdentity } from "@tx-meta/dcu-kit/harness";
import { Effect } from "effect";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadState } from "./state.js";
import { loadScriptRefs, cexplorerTxUrl } from "./context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const groupSuffix = process.env.GROUP!;
  const lucid = await Lucid(
    new Blockfrost(process.env.BLOCKFROST_URL!, process.env.BLOCKFROST_KEY!),
    "Preprod",
  );
  const state = loadState();
  const dcu = createDcuSession(lucid, state.settingsPolicy!);
  const scriptRefs = await loadScriptRefs(lucid);
  const groupUnit =
    state.groupPolicyId! + assetNameLabels.prefix100 + groupSuffix;

  const memberCount = async () => {
    const u = patchInlineDatum(await lucid.utxoByUnit(groupUnit));
    const d = await Effect.runPromise(parseGroupCip68Datum(u.datum!));
    return { txHash: u.txHash, count: d.groupDatum.member_count };
  };

  const joinAs = async (seedEnv: string, accountSuffix: string) => {
    lucid.selectWallet.fromSeed(process.env[seedEnv]!);
    const before = await memberCount();
    const tx = await dcu
      .joinGroup({
        groupTokenSuffix: groupSuffix,
        accountTokenSuffix: accountSuffix,
        scriptRefs,
      })
      .unsafeRun();
    const signed = await tx.sign.withWallet().complete();
    const h = await signed.submit();
    await lucid.awaitTx(h);
    for (let i = 0; i < 30; i++) {
      const now = await memberCount();
      if (now.txHash !== before.txHash) break;
      await sleep(6000);
    }
    console.log(
      `  ✓ join ${accountSuffix.slice(0, 8)}… (${seedEnv}): ${cexplorerTxUrl(h)}`,
    );
    return h;
  };

  const joins: Record<string, string> = {};
  let g = await memberCount();
  console.log(`group ${groupSuffix.slice(0, 8)}… member_count=${g.count}`);

  if (g.count < 1n)
    joins.user1 = await joinAs(
      "USER1_SEED",
      "b314ee9cd6b87c8e2916768684318b38adcad80e3fd5375c829a68bb",
    );
  if ((await memberCount()).count < 2n)
    joins.user2 = await joinAs(
      "USER2_SEED",
      "ad864b5741b2775a94ccba936602eff06de5b20d127e50257e7d3c7f",
    );

  g = await memberCount();
  console.log(`group FULL: member_count=${g.count} (max_members=2)`);

  // C9: ADMIN's B1 account attempts the third join — must be rejected.
  lucid.selectWallet.fromSeed(process.env.ADMIN_SEED!);
  const b1Account = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "evidence", "p2-account-lifecycle.json"),
      "utf8",
    ),
  ).evidence.B1.account as string;
  const evidence = await Effect.runPromise(
    captureRejection(
      lucid,
      {
        label: "C9 join beyond max_members",
        deployment: deploymentIdentity(dcu.protocol, "Preprod"),
        evaluation: "local-uplc",
      },
      dcu
        .joinGroup({
          groupTokenSuffix: groupSuffix,
          accountTokenSuffix: b1Account,
          scriptRefs,
        })
        .program(),
    ),
  );
  console.log(`  ✓ ${evidence.label} — rejected, captured`);

  const dir = path.join(__dirname, "evidence", "negative-proofs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `C9-${evidence.timestamp.replace(/[:.]/g, "-")}.json`),
    JSON.stringify(
      evidence,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
  fs.writeFileSync(
    path.join(__dirname, "evidence", "p2-c9-joins.json"),
    JSON.stringify(
      {
        group: groupSuffix,
        joins,
        finalMemberCount: g.count.toString(),
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("\nC9 complete.");
}

main().catch((e) => {
  console.error(String(e).slice(0, 600));
  process.exit(1);
});
