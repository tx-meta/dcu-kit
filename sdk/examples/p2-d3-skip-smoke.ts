/**
 * P2 matrix D3: deterministic scriptRef-skip smoke on all four one-shot
 * create endpoints (escrow v1, escrow v2, pool, project).
 *
 * The 7fe15be fix: seed selection filters scriptRef UTxOs out of
 * `sortUtxos(wallet)`. The skip is proven DETERMINISTICALLY: before each
 * endpoint run, a dedicated wallet's ENTIRE UTxO set is consolidated into one
 * prep tx — output#0 pays-to-self WITH a scriptRef, output#1 is the ordinary
 * seed. Same txid, so out-ref sort order = output index order and the
 * scriptRef UTxO sorts FIRST. The old logic would pick (and destroy) it; the
 * fixed logic must pick output#1.
 *
 * Evidence per run: (1) the wallet's full sorted UTxO set, (2) the scriptRef
 * UTxO first in sort order, (3) the endpoint skipped it (prep#0 not in the
 * submitted tx's inputs), (4) the selected ordinary seed (prep#1 consumed),
 * (5) the scriptRef UTxO unspent after confirmation.
 *
 * Funds a fresh dedicated wallet from ADMIN; escrow amounts are minimal.
 * Writes evidence/d3-skip-smoke.json.
 */

import "dotenv/config";
import { Blockfrost, Lucid, walletFromSeed } from "@lucid-evolution/lucid";
import { alwaysFailsValidator } from "@tx-meta/dcu-kit";
import { createEscrow as createEscrowV1 } from "@tx-meta/dcu-kit/escrow";
import {
  createEscrow as createEscrowV2,
  createPool,
  createProject,
} from "@tx-meta/dcu-kit/escrow/v2";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { cexplorerTxUrl } from "./context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The SDK's canonical out-ref sort (txHash, then outputIndex).
const sortKey = (u: { txHash: string; outputIndex: number }) =>
  `${u.txHash}#${u.outputIndex.toString().padStart(4, "0")}`;

async function main() {
  const lucid = await Lucid(
    new Blockfrost(process.env.BLOCKFROST_URL!, process.env.BLOCKFROST_KEY!),
    "Preprod",
  );

  // Dedicated wallet = ADMIN's seed at accountIndex 1: deterministic and
  // recoverable, no throwaway secret to persist. Empty before this run.
  const seedPhrase = process.env.ADMIN_SEED!;
  const dedicated = walletFromSeed(seedPhrase, {
    network: "Preprod",
    addressType: "Base",
    accountIndex: 1,
  });
  console.log("dedicated wallet (ADMIN accountIndex 1):", dedicated.address);

  lucid.selectWallet.fromSeed(seedPhrase, { accountIndex: 1 });
  const existing = await lucid.wallet().getUtxos();
  const balance = existing.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
  let fundHash = "(already funded)";
  if (balance < 25_000_000n) {
    lucid.selectWallet.fromSeed(process.env.ADMIN_SEED!);
    const fundTx = await lucid
      .newTx()
      .pay.ToAddress(dedicated.address, { lovelace: 45_000_000n })
      .complete();
    const fundSigned = await fundTx.sign.withWallet().complete();
    fundHash = await fundSigned.submit();
    await lucid.awaitTx(fundHash);
    console.log("funded:", cexplorerTxUrl(fundHash));
    lucid.selectWallet.fromSeed(seedPhrase, { accountIndex: 1 });
  } else {
    console.log(`already funded: ${balance / 1_000_000n} ADA`);
  }
  const waitWallet = async (txHash: string) => {
    for (let i = 0; i < 40; i++) {
      const utxos = await lucid.wallet().getUtxos();
      if (utxos.some((u) => u.txHash === txHash)) return;
      await sleep(6000);
    }
    throw new Error(`tx ${txHash.slice(0, 8)} not indexed for wallet`);
  };
  if (fundHash !== "(already funded)") await waitWallet(fundHash);

  // Consolidate the ENTIRE wallet into the deterministic pair:
  // out#0 = self + scriptRef (alwaysFails, small), out#1 = ordinary seed.
  const prep = async () => {
    const all = await lucid.wallet().getUtxos();
    const tx = await lucid
      .newTx()
      .collectFrom(all)
      .pay.ToAddressWithData(
        dedicated.address,
        undefined,
        { lovelace: 3_000_000n },
        {
          type: "PlutusV3",
          script: alwaysFailsValidator.elseAlwaysFails.script,
        },
      )
      // out#1 gets everything else as change to the same address; force a
      // second output by paying a fixed amount and letting change join it is
      // NOT deterministic — instead pay out#1 explicitly and let change be
      // output#2? No: spend ALL inputs, out#0 fixed, out#1 = remainder minus
      // fee is exactly the change output. lucid appends change LAST, so with
      // one explicit output the change IS output#1.
      .complete();
    const signed = await tx.sign.withWallet().complete();
    const h = await signed.submit();
    await lucid.awaitTx(h);
    await waitWallet(h);
    const utxos = (await lucid.wallet().getUtxos()).sort((a, b) =>
      sortKey(a) < sortKey(b) ? -1 : 1,
    );
    return { prepHash: h, utxos };
  };

  const runs: Record<string, unknown>[] = [];
  const now = BigInt(Date.now());

  const cases: Array<{
    name: string;
    build: () => Promise<{ tx: { toTransaction(): any; sign: any } } | any>;
  }> = [
    {
      name: "escrow-v1-create",
      build: () =>
        createEscrowV1(lucid, {
          beneficiaryAddress: dedicated.address,
          verifier: {
            type: "Key",
            hash: "a0a1a2a3a4a5a6a7a8a9b0b1b2b3b4b5b6b7b8b9c0c1c2c3c4c5c6c7",
          },
          milestones: [2_000_000n],
          expiry: now + 86_400_000n,
        }).unsafeRun(),
    },
    {
      name: "escrow-v2-create",
      build: () =>
        createEscrowV2(lucid, {
          beneficiaryAddress: dedicated.address,
          // Must be distinct from the beneficiary (SDK guard): ADMIN main address.
          verifier:
            "addr_test1qp8e3lcpxt45sc3vaujg9u0v6h8mmnz5xuefpn3lpxf00uwdyngj6ay42u5wwhw5pfzsxmw4lvgcp670dyfwh32k7kfq2hk8lm",
          milestones: [{ amount: 2_000_000n, deadline: now + 86_400_000n }],
          fundingMode: "PerMilestone",
          timeoutPolicy: "RefundToFunder",
          title: "P2 D3 smoke",
        }).unsafeRun(),
    },
    {
      name: "pool-create",
      build: () => createPool(lucid, { title: "P2 D3 pool" }).unsafeRun(),
    },
    {
      name: "project-create",
      build: () => createProject(lucid, { title: "P2 D3 project" }).unsafeRun(),
    },
  ];

  const skip = (process.env.SKIP ?? "").split(",").filter(Boolean);
  for (const c of cases) {
    if (skip.includes(c.name)) {
      console.log(`  (skip) ${c.name} — already captured`);
      continue;
    }
    const { prepHash, utxos } = await prep();
    const scriptRefUtxo = utxos.find((u) => u.scriptRef);
    const sortedSet = utxos.map((u) => ({
      outRef: `${u.txHash}#${u.outputIndex}`,
      lovelace: u.assets.lovelace?.toString(),
      hasScriptRef: !!u.scriptRef,
    }));
    if (!scriptRefUtxo) throw new Error("prep produced no scriptRef UTxO");
    const scriptRefFirst =
      sortedSet[0].outRef ===
      `${scriptRefUtxo.txHash}#${scriptRefUtxo.outputIndex}`;

    const built = await c.build();
    const tx = built.tx ?? built;
    // Inspect the built tx's inputs BEFORE submitting.
    const body = tx.toTransaction().body();
    const inputs = body.inputs();
    const spent: string[] = [];
    for (let i = 0; i < inputs.len(); i++) {
      const inp = inputs.get(i);
      spent.push(`${inp.transaction_id().to_hex()}#${Number(inp.index())}`);
    }
    const prepRef = `${scriptRefUtxo.txHash}#${scriptRefUtxo.outputIndex}`;
    const skipped = !spent.includes(prepRef);
    const seedRef = spent.find((s) => s.startsWith(prepHash)) ?? spent[0];

    const signed = await tx.sign.withWallet().complete();
    const h = await signed.submit();
    await lucid.awaitTx(h);
    await waitWallet(h);
    const after = await lucid.utxosByOutRef([
      { txHash: scriptRefUtxo.txHash, outputIndex: scriptRefUtxo.outputIndex },
    ]);
    const unspentAfter = after.filter(Boolean).length === 1;

    console.log(
      `  ✓ ${c.name}: scriptRefFirst=${scriptRefFirst} skipped=${skipped} seed=${seedRef.slice(0, 12)}… unspentAfter=${unspentAfter} tx=${h.slice(0, 12)}…`,
    );
    runs.push({
      endpoint: c.name,
      prepTx: prepHash,
      sortedWalletSet: sortedSet,
      scriptRefUtxo: prepRef,
      scriptRefFirstInSortOrder: scriptRefFirst,
      endpointSkippedScriptRef: skipped,
      selectedSeed: seedRef,
      scriptRefUnspentAfter: unspentAfter,
      createTx: h,
      pass: scriptRefFirst && skipped && unspentAfter,
    });
  }

  const outPath = path.join(__dirname, "evidence", "d3-skip-smoke.json");
  const prior = fs.existsSync(outPath)
    ? (JSON.parse(fs.readFileSync(outPath, "utf8")).runs ?? [])
    : [];
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        dedicatedWalletAddress: dedicated.address,
        fundTx: fundHash,
        runs: [...prior, ...runs],
        note: "Dedicated wallet = ADMIN seed at accountIndex 1 (recoverable). A first attempt funded a generated-seed wallet whose phrase was not persisted; its 60 tADA (fund tx 78b44fab…) is stranded — testnet only.",
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  const allPass = runs.every((r) => (r as { pass: boolean }).pass);
  console.log(
    `\nD3 ${allPass ? "PASS" : "FAIL"} — evidence/d3-skip-smoke.json`,
  );
  if (!allPass) process.exit(1);
}

main().catch((e) => {
  console.error(String(e).slice(0, 700));
  process.exit(1);
});
