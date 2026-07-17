/**
 * P2 recommit-clock starter (dedicated, unentangled from the recovery group).
 *
 * The single-group example harness cannot run a second concurrent group in the
 * same three wallets (its join guard blocks an account already in another
 * group). This drives the SDK session directly: two FRESH accounts in the ADMIN
 * wallet, a new group at the config-safety-envelope floors, both joins, and
 * start-group — which anchors `start_time`, the recommit clock. The rotation
 * lap + begin-recommit run on day 2 before the re-seal at start_time + 25h.
 *
 * Writes evidence/p2-recommit-state.json. Run once on Preprod.
 */

import "dotenv/config";
import { Lucid, Blockfrost, paymentCredentialOf } from "@lucid-evolution/lucid";
import {
  createDcuSession,
  GroupDatum,
  assetNameLabels,
} from "@tx-meta/dcu-kit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadState } from "./state.js";
import { loadScriptRefs, cexplorerTxUrl } from "./context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "evidence", "p2-recommit-state.json");
const FLOOR = 86_400_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const key = process.env.BLOCKFROST_KEY!;
  const url =
    process.env.BLOCKFROST_URL ??
    "https://cardano-preprod.blockfrost.io/api/v0";
  const lucid = await Lucid(new Blockfrost(url, key), "Preprod");
  lucid.selectWallet.fromSeed(process.env.ADMIN_SEED!);
  const address = await lucid.wallet().address();
  const adminPkh = paymentCredentialOf(address).hash;

  const state = loadState();
  const dcu = createDcuSession(lucid, state.settingsPolicy!);
  const scriptRefs = await loadScriptRefs(lucid);

  // Poll the wallet UTxO endpoint until it reflects the confirmed tx (its change
  // output appears). Blockfrost lags chain state, so coin selection for the next
  // tx must not run until the previous change is indexed, or freshSeed picks a
  // now-spent input and resolveUtxoByOutRef throws UtxoNotFoundError.
  const waitIndexed = async (txHash: string, label: string) => {
    await lucid.awaitTx(txHash);
    for (let i = 0; i < 30; i++) {
      const utxos = await lucid.wallet().getUtxos();
      if (utxos.some((u) => u.txHash === txHash)) break;
      await sleep(6000);
    }
    await sleep(4000);
    console.log(`  ✓ ${label}: ${cexplorerTxUrl(txHash)}`);
  };

  // A spendable seed that is NOT any of the given already-used out-refs.
  const freshSeed = async (used: Set<string> = new Set()) => {
    const utxos = await lucid.wallet().getUtxos();
    const u = utxos.filter(
      (x) =>
        !x.scriptRef &&
        x.assets.lovelace > 60_000_000n &&
        !used.has(`${x.txHash}#${x.outputIndex}`),
    )[0];
    if (!u) throw new Error("no spendable >60 ADA UTxO in ADMIN wallet");
    return { txHash: u.txHash, outputIndex: u.outputIndex };
  };

  const out: Record<string, unknown> = { label: "P2 recommit group" };

  // Reuse accounts already created in this wallet (REUSE_ACCOUNTS=suffix,suffix);
  // the first recommit-start attempt left account A behind.
  const reuse = (process.env.REUSE_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const suffixes: string[] = [...reuse];
  const usedSeeds = new Set<string>();
  while (suffixes.length < 2) {
    const seed = await freshSeed(usedSeeds);
    usedSeeds.add(`${seed.txHash}#${seed.outputIndex}`);
    const { tx, accountTokenSuffix } = await dcu
      .createAccount({ selected_out_ref: seed })
      .unsafeRun();
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    await waitIndexed(
      txHash,
      `create-account (${accountTokenSuffix.slice(0, 8)}…)`,
    );
    suffixes.push(accountTokenSuffix);
  }
  out.memberAccountSuffixes = suffixes;

  // --- Recommit group at the envelope floors --------------------------------
  const groupDatum: GroupDatum = {
    contribution_fee_policyid: "",
    contribution_fee_assetname: "",
    contribution_fee: 5_000_000n,
    joining_fee_policyid: "",
    joining_fee_assetname: "",
    joining_fee: 0n,
    penalty_fee_policyid: "",
    penalty_fee_assetname: "",
    penalty_fee: 2_000_000n,
    creator_bond: 0n,
    interval_length: 300_000n,
    num_rounds: 0n,
    max_members: 5n,
    collateral_rounds: 1n,
    payout_mode: "Push",
    recovery_threshold: 2n,
    recovery_timelock: FLOOR,
    member_count: 0n,
    active_member_count: 0n,
    member_slots: [],
    era_start_round: 0n,
    recommit_window: FLOOR,
    reserve_join_levy: 0n,
    reserve_round_levy: 0n,
    is_active: true,
    is_started: false,
    start_time: 0n,
    last_distributed_round: -1n,
    grace_period_length: 0n,
    creator_payment_credential: { VerificationKey: [adminPkh] },
    member_token_names: [],
  };

  const { tx: gtx, groupTokenSuffix } = await dcu
    .createGroup({
      groupName: "P2 Recommit Group",
      groupDescription: "P2 rehearsal: recommit window at the floor",
      groupDatum,
      utxoToSpend: await freshSeed(usedSeeds),
      scriptRefs,
    })
    .unsafeRun();
  const gsigned = await gtx.sign.withWallet().complete();
  const ghash = await gsigned.submit();
  await waitIndexed(ghash, `create-group (${groupTokenSuffix.slice(0, 8)}…)`);
  out.groupTokenSuffix = groupTokenSuffix;
  out.groupPolicyId = state.groupPolicyId;

  // --- Both fresh accounts join (ADMIN signs; both tokens in its wallet) -----
  for (let i = 0; i < suffixes.length; i++) {
    const tx = await dcu
      .joinGroup({
        groupTokenSuffix,
        accountTokenSuffix: suffixes[i],
        currentTime: BigInt(Date.now()),
        scriptRefs,
      })
      .unsafeRun();
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    await waitIndexed(txHash, `join member ${i} (slot ${i})`);
  }

  // --- Start: anchors start_time = the recommit clock -----------------------
  const stx = await dcu
    .startGroup({
      groupTokenSuffix,
      currentTime: BigInt(Date.now()),
      scriptRefs,
    })
    .unsafeRun();
  const ssigned = await stx.sign.withWallet().complete();
  const shash = await ssigned.submit();
  await waitIndexed(shash, "start-group");
  out.startTxHash = shash;
  out.startedAtIso = new Date().toISOString();
  out.note =
    "start_time anchors the recommit clock; re-seal valid at start_time + 86_400_000 ms. Run rotation lap + begin-recommit before the re-seal.";

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      out,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
  console.log(
    "\nRecommit group started. State:",
    path.relative(process.cwd(), OUT),
  );
  console.log("Members:", suffixes.map((s) => s.slice(0, 8)).join(", "));
  console.log("Group:", groupTokenSuffix);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
