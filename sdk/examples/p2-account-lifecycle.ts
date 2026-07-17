/**
 * P2 matrix B1/B3/B4: the P1 profile-commitment datum semantics, live.
 *  B1 create-account default → on-chain profile_commitment == "".
 *  B3 update-account (omitted) → the existing commitment is PRESERVED.
 *  B4 update-account ("")     → the commitment is CLEARED to "".
 * Uses two fresh accounts in the ADMIN wallet. Reads each account UTxO datum
 * back from chain between steps. Writes evidence/p2-account-lifecycle.json.
 */

import "dotenv/config";
import {
  Blockfrost,
  Data,
  Lucid,
  paymentCredentialOf,
} from "@lucid-evolution/lucid";
import {
  AccountDatum,
  computeProfileCommitment,
  createDcuSession,
  assetNameLabels,
} from "@tx-meta/dcu-kit";
import { randomBytes } from "node:crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadState } from "./state.js";
import { cexplorerTxUrl } from "./context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const key = process.env.BLOCKFROST_KEY!;
  const url = process.env.BLOCKFROST_URL!;
  const lucid = await Lucid(new Blockfrost(url, key), "Preprod");
  lucid.selectWallet.fromSeed(process.env.ADMIN_SEED!);
  const address = await lucid.wallet().address();
  void paymentCredentialOf(address);

  const state = loadState();
  const dcu = createDcuSession(lucid, state.settingsPolicy!);
  const accountPolicy = state.accountPolicyId!;

  const waitTx = async (txHash: string, label: string) => {
    await lucid.awaitTx(txHash);
    for (let i = 0; i < 30; i++) {
      const utxos = await lucid.wallet().getUtxos();
      if (utxos.some((u) => u.txHash === txHash)) break;
      await sleep(6000);
    }
    await sleep(4000);
    console.log(`  ✓ ${label}: ${cexplorerTxUrl(txHash)}`);
  };

  const freshSeed = async (used: Set<string>) => {
    const utxos = await lucid.wallet().getUtxos();
    const u = utxos.filter(
      (x) =>
        !x.scriptRef &&
        x.assets.lovelace > 20_000_000n &&
        !used.has(`${x.txHash}#${x.outputIndex}`),
    )[0];
    if (!u) throw new Error("no spendable UTxO");
    return { txHash: u.txHash, outputIndex: u.outputIndex };
  };

  // Read the profile_commitment currently locked at the account script UTxO.
  const readCommitment = async (suffix: string) => {
    const unit = accountPolicy + assetNameLabels.prefix100 + suffix;
    const utxo = await lucid.utxoByUnit(unit);
    const d = Data.from(utxo.datum!, AccountDatum) as unknown as {
      profile_commitment: string;
    };
    return d.profile_commitment;
  };

  const used = new Set<string>();
  const evidence: Record<string, unknown> = {};

  // --- B1: create-account with NO commitment → "" ---------------------------
  {
    const seed = await freshSeed(used);
    used.add(`${seed.txHash}#${seed.outputIndex}`);
    const { tx, accountTokenSuffix } = await dcu
      .createAccount({ selected_out_ref: seed })
      .unsafeRun();
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    await waitTx(
      txHash,
      `B1 create-account default (${accountTokenSuffix.slice(0, 8)}…)`,
    );
    const commitment = await readCommitment(accountTokenSuffix);
    evidence.B1 = {
      account: accountTokenSuffix,
      txHash,
      onChainCommitment: commitment,
      pass: commitment === "",
    };
    console.log(
      `    B1 on-chain commitment: "${commitment}" (pass=${commitment === ""})`,
    );
  }

  // --- B3/B4 on a second account with an initial commitment -----------------
  {
    const seed = await freshSeed(used);
    used.add(`${seed.txHash}#${seed.outputIndex}`);
    const salt = randomBytes(32).toString("hex");
    const initial = computeProfileCommitment(
      JSON.stringify({ name: "@p2-b3b4" }),
      salt,
    );
    const { tx, accountTokenSuffix } = await dcu
      .createAccount({ selected_out_ref: seed, profileCommitment: initial })
      .unsafeRun();
    const s1 = await tx.sign.withWallet().complete();
    const h1 = await s1.submit();
    await waitTx(
      h1,
      `create-account with commitment (${accountTokenSuffix.slice(0, 8)}…)`,
    );
    const c0 = await readCommitment(accountTokenSuffix);

    // B3: omitted → preserve
    const utx = await dcu.updateAccount({ accountTokenSuffix }).unsafeRun();
    const s2 = await utx.sign.withWallet().complete();
    const h2 = await s2.submit();
    await waitTx(h2, "B3 update-account omitted (preserve)");
    const c1 = await readCommitment(accountTokenSuffix);
    evidence.B3 = {
      account: accountTokenSuffix,
      before: c0,
      afterOmittedUpdate: c1,
      pass: c1 === initial && c1 === c0,
    };
    console.log(
      `    B3 preserved: ${c1 === initial} (before=${c0.slice(0, 12)}… after=${c1.slice(0, 12)}…)`,
    );

    // B4: "" → clear
    const utx2 = await dcu
      .updateAccount({ accountTokenSuffix, profileCommitment: "" })
      .unsafeRun();
    const s3 = await utx2.sign.withWallet().complete();
    const h3 = await s3.submit();
    await waitTx(h3, 'B4 update-account "" (clear)');
    const c2 = await readCommitment(accountTokenSuffix);
    evidence.B4 = {
      account: accountTokenSuffix,
      afterClear: c2,
      pass: c2 === "",
    };
    console.log(`    B4 cleared: ${c2 === ""} (after="${c2}")`);
  }

  fs.writeFileSync(
    path.join(__dirname, "evidence", "p2-account-lifecycle.json"),
    JSON.stringify(
      { evidence, capturedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  console.log("\nB1/B3/B4 done. evidence/p2-account-lifecycle.json");
}

main().catch((e) => {
  console.error(String(e).slice(0, 400));
  process.exit(1);
});
