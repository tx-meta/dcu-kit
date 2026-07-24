/**
 * P2 matrix B6 + the C4/C5/C9 fixture: a pre-join group owned by USER1.
 *
 * Creates a group at the config-safety-envelope floors with max_members=2
 * (so two joins fill it — the later C9 join-beyond-max fixture), then runs
 * the B6 pre-join update: a config change WITHIN the envelope (contribution
 * fee 5→4 ADA, recovery_timelock floor→2 days) that the validator accepts.
 * Reads the datum back and verifies the change. Leaves the group PRE-JOIN
 * for the C4/C5 raw update proofs.
 *
 * Writes evidence/p2-prejoin-group.json. Run once on Preprod.
 */

import "dotenv/config";
import { Lucid, Blockfrost, paymentCredentialOf } from "@lucid-evolution/lucid";
import {
  createDcuSession,
  GroupDatum,
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
const FLOOR = 86_400_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const lucid = await Lucid(
    new Blockfrost(process.env.BLOCKFROST_URL!, process.env.BLOCKFROST_KEY!),
    "Preprod",
  );
  lucid.selectWallet.fromSeed(process.env.USER1_SEED!);
  const address = await lucid.wallet().address();
  const pkh = paymentCredentialOf(address).hash;

  const state = loadState();
  const dcu = createDcuSession(lucid, state.settingsPolicy!);
  const scriptRefs = await loadScriptRefs(lucid);

  const groupDatum: GroupDatum = {
    contribution_fee_policyid: "",
    contribution_fee_assetname: "",
    contribution_fee: 5_000_000n,
    joining_fee_policyid: "",
    joining_fee_assetname: "",
    joining_fee: 1_000_000n,
    penalty_fee_policyid: "",
    penalty_fee_assetname: "",
    penalty_fee: 2_000_000n,
    creator_bond: 0n,
    interval_length: 300_000n,
    num_rounds: 0n,
    max_members: 2n,
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
    creator_payment_credential: { VerificationKey: [pkh] },
    member_token_names: [],
  };

  const utxos = await lucid.wallet().getUtxos();
  const seed = utxos.filter(
    (u) => !u.scriptRef && u.assets.lovelace > 60_000_000n,
  )[0];
  if (!seed) throw new Error("no spendable >60 ADA UTxO in USER1 wallet");

  const { tx, groupTokenSuffix } = await dcu
    .createGroup({
      groupName: "P2 Pre-Join Group",
      groupDescription: "B6 envelope update + C4/C5 proofs + C9 fixture",
      groupDatum,
      utxoToSpend: { txHash: seed.txHash, outputIndex: seed.outputIndex },
      scriptRefs,
    })
    .unsafeRun();
  const signed = await tx.sign.withWallet().complete();
  const createHash = await signed.submit();
  await lucid.awaitTx(createHash);
  console.log(
    `  ✓ create-group ${groupTokenSuffix.slice(0, 8)}…: ${cexplorerTxUrl(createHash)}`,
  );

  const groupUnit =
    state.groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
  // Wait for the group UTxO AND the admin (222) token to be indexed.
  for (let i = 0; i < 30; i++) {
    try {
      const u = await lucid.utxoByUnit(groupUnit);
      const w = await lucid.wallet().getUtxos();
      if (u && w.some((x) => x.txHash === createHash)) break;
    } catch {
      /* not indexed yet */
    }
    await sleep(6000);
  }
  await sleep(4000);

  // B6: pre-join update WITHIN the envelope — accepted by the validator.
  const updated: GroupDatum = {
    ...groupDatum,
    contribution_fee: 4_000_000n,
    recovery_timelock: 2n * FLOOR,
  };
  const utx = await dcu
    .updateGroup({ groupTokenSuffix, updatedDatum: updated })
    .unsafeRun();
  const usigned = await utx.sign.withWallet().complete();
  const updateHash = await usigned.submit();
  await lucid.awaitTx(updateHash);
  console.log(
    `  ✓ B6 pre-join update (within envelope): ${cexplorerTxUrl(updateHash)}`,
  );

  // Read back and verify.
  let after: { contribution_fee: bigint; recovery_timelock: bigint } | null =
    null;
  for (let i = 0; i < 30; i++) {
    const u = patchInlineDatum(await lucid.utxoByUnit(groupUnit));
    if (u.txHash === updateHash) {
      const d = await Effect.runPromise(parseGroupCip68Datum(u.datum!));
      after = d.groupDatum;
      break;
    }
    await sleep(6000);
  }
  if (!after) throw new Error("updated group UTxO not indexed");
  const pass =
    after.contribution_fee === 4_000_000n &&
    after.recovery_timelock === 2n * FLOOR;
  console.log(
    `    datum after update: contribution_fee=${after.contribution_fee} recovery_timelock=${after.recovery_timelock} (pass=${pass})`,
  );

  fs.writeFileSync(
    path.join(__dirname, "evidence", "p2-prejoin-group.json"),
    JSON.stringify(
      {
        label: "P2 pre-join group (B6 + C4/C5/C9 fixture)",
        groupTokenSuffix,
        creatorWallet: "USER1",
        maxMembers: "2",
        createTxHash: createHash,
        B6: {
          updateTxHash: updateHash,
          changed: {
            contribution_fee: "5000000 -> 4000000",
            recovery_timelock: "86400000 -> 172800000",
          },
          verifiedOnChain: pass,
        },
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nPre-join group ready: ${groupTokenSuffix}`);
}

main().catch((e) => {
  console.error(String(e).slice(0, 600));
  process.exit(1);
});
