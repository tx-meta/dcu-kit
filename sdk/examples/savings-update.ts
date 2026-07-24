/**
 * Savings Update Fund Example
 *
 * The quorum amends the charter's mutable fields (title, purchase band,
 * withdrawal policy, cycle end) or rotates the quorum credential. The asset,
 * share value, totals, and status are immutable on-chain.
 *
 * Wallet selection: ACTIVE_WALLET must satisfy the CURRENT quorum.
 *
 * Env (each optional; only provided fields change):
 *   TITLE="..." MIN_SHARES=1 MAX_SHARES=200 WITHDRAWAL_POLICY=0|1
 *   CYCLE_END_MINUTES=...   NEW_QUORUM=addr...
 *
 * Usage:
 *   MAX_SHARES=200 pnpm run savings-update
 */

import { updateFund } from "@tx-meta/dcu-kit/savings";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const state = loadState();
  const savingsRef = state.scriptRefSavings
    ? (await lucid.utxosByOutRef([state.scriptRefSavings]))[0]
    : undefined;
  if (!state.savingsFundTokenName) {
    throw new Error("Run savings-create first.");
  }

  const tx = await updateFund(lucid, {
    scriptRef: savingsRef,
    fundTokenName: state.savingsFundTokenName,
    ...(process.env.TITLE ? { title: process.env.TITLE } : {}),
    ...(process.env.MIN_SHARES
      ? { minSharesPerDeposit: BigInt(process.env.MIN_SHARES) }
      : {}),
    ...(process.env.MAX_SHARES
      ? { maxSharesPerDeposit: BigInt(process.env.MAX_SHARES) }
      : {}),
    ...(process.env.WITHDRAWAL_POLICY
      ? { withdrawalPolicy: BigInt(process.env.WITHDRAWAL_POLICY) }
      : {}),
    ...(process.env.CYCLE_END_MINUTES
      ? {
          cycleEnd: BigInt(
            Date.now() + Number(process.env.CYCLE_END_MINUTES) * 60_000,
          ),
        }
      : {}),
    ...(process.env.NEW_QUORUM ? { quorum: process.env.NEW_QUORUM } : {}),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);
  console.log("Charter update confirmed.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
