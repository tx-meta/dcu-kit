import "dotenv/config";
import { Lucid, Blockfrost, Data } from "@lucid-evolution/lucid";
import {
  AccountDatum,
  createDcuSession,
  assetNameLabels,
} from "@tx-meta/dcu-kit";
import { loadState } from "./state.js";
import { cexplorerTxUrl } from "./context.js";
import fs from "fs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const suffix = "e2e1808e"; // resolved below from evidence
async function main() {
  const lucid = await Lucid(
    new Blockfrost(process.env.BLOCKFROST_URL!, process.env.BLOCKFROST_KEY!),
    "Preprod",
  );
  lucid.selectWallet.fromSeed(process.env.ADMIN_SEED!);
  const state = loadState();
  const dcu = createDcuSession(lucid, state.settingsPolicy!);
  // full suffix from wallet: find the 222 token starting with e2e1808e
  const w = await lucid.wallet().getUtxos();
  let full = "";
  for (const u of w)
    for (const k of Object.keys(u.assets)) {
      if (
        k.startsWith(
          state.accountPolicyId! + assetNameLabels.prefix222 + "e2e1808e",
        )
      )
        full = k.slice(
          state.accountPolicyId!.length + assetNameLabels.prefix222.length,
        );
    }
  if (!full) throw new Error("account e2e1808e… 222 token not in ADMIN wallet");
  const unit = state.accountPolicyId! + assetNameLabels.prefix100 + full;
  const read = async () =>
    (
      Data.from(
        (await lucid.utxoByUnit(unit)).datum!,
        AccountDatum,
      ) as unknown as { profile_commitment: string }
    ).profile_commitment;
  console.log("before:", (await read()).slice(0, 16) + "…");
  const tx = await dcu
    .updateAccount({ accountTokenSuffix: full, profileCommitment: "" })
    .unsafeRun();
  const signed = await tx.sign.withWallet().complete();
  const h = await signed.submit();
  await lucid.awaitTx(h);
  console.log("B4 clear tx:", cexplorerTxUrl(h));
  let after = "pending";
  for (let i = 0; i < 30; i++) {
    const u = await lucid.utxoByUnit(unit);
    if (u.txHash === h) {
      after = (
        Data.from(u.datum!, AccountDatum) as unknown as {
          profile_commitment: string;
        }
      ).profile_commitment;
      break;
    }
    await sleep(6000);
  }
  console.log(`B4 after clear: "${after}" (pass=${after === ""})`);
  const ev = JSON.parse(
    fs.readFileSync("evidence/p2-account-lifecycle.json", "utf8"),
  );
  ev.evidence.B4 = {
    account: full,
    clearTx: h,
    afterClear: after,
    pass: after === "",
  };
  ev.capturedAt = new Date().toISOString();
  fs.writeFileSync(
    "evidence/p2-account-lifecycle.json",
    JSON.stringify(ev, null, 2) + "\n",
  );
}
main().catch((e) => {
  console.error(String(e).slice(0, 400));
  process.exit(1);
});
