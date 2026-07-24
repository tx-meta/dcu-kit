/**
 * Savings Deposit Example
 *
 * Pays into the fund from the active member's wallet. Tag 0 (default) buys
 * share units; tag 1 contributes to the social fund; tag 2 is an untagged
 * top-up (penalties, donations) that flows into the next share-out pot.
 *
 * Wallet selection: ACTIVE_WALLET (default USER1) — must have joined.
 *
 * Env:
 *   UNITS=10        tag 0: share units to buy
 *   TAG=1 AMOUNT=…  tag 1/2: amount in base units of the fund asset
 *
 * Usage:
 *   UNITS=10 pnpm run savings-deposit
 *   TAG=1 AMOUNT=3000000 pnpm run savings-deposit
 */

import { deposit } from "@tx-meta/dcu-kit/savings";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, savingsSuffixKey } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  const wallet = await selectEnvWallet(lucid, "USER1");

  const state = loadState();
  const savingsRef = state.scriptRefSavings
    ? (await lucid.utxosByOutRef([state.scriptRefSavings]))[0]
    : undefined;
  const fundTokenName = state.savingsFundTokenName;
  const memberTokenSuffix = state[savingsSuffixKey(wallet)];
  if (!fundTokenName || !memberTokenSuffix) {
    throw new Error("Run savings-create and savings-join first.");
  }

  const fundTag = BigInt(process.env.TAG ?? 0);
  const tx = await deposit(lucid, {
    scriptRef: savingsRef,
    fundTokenName,
    memberTokenSuffix,
    fundTag,
    ...(fundTag === 0n
      ? { units: BigInt(process.env.UNITS ?? 10) }
      : { amount: BigInt(process.env.AMOUNT ?? 1_000_000) }),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);
  console.log("Deposit confirmed.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
