/**
 * Create Savings Fund Example
 *
 * Opens a savings fund (primitive #7): the anchor NFT carries the charter
 * (share price, purchase band, withdrawal policy) and custodies the pooled
 * fund. Members join with savings-join and buy shares with savings-deposit.
 *
 * Wallet selection: ACTIVE_WALLET pays the anchor min-ADA (default USER1);
 * its payment credential is the default quorum.
 *
 * Env:
 *   TITLE="..."                 max 64 UTF-8 bytes
 *   SHARE_VALUE=1000000         price of one share unit (base units)
 *   MIN_SHARES=1 MAX_SHARES=100 per-transaction purchase band
 *   WITHDRAWAL_POLICY=0|1       0 = locked until share-out (VSLA), 1 = ASCA
 *   CYCLE_END_MINUTES=...       CloseCycle invalid before this (optional)
 *   QUORUM=addr...              ratification authority (default: own wallet)
 *   ASSET_POLICY= ASSET_NAME=   native-token fund (omit for ADA)
 *
 * Usage:
 *   pnpm run savings-create
 */

import { createFund } from "@tx-meta/dcu-kit/savings";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, saveState } from "./state.js";

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
  const title = process.env.TITLE ?? "Preprod sweep savings fund";
  const cycleEnd = process.env.CYCLE_END_MINUTES
    ? BigInt(Date.now() + Number(process.env.CYCLE_END_MINUTES) * 60_000)
    : undefined;

  console.log(`Creating savings fund "${title}"`);
  const { tx, fundTokenName } = await createFund(lucid, {
    scriptRef: savingsRef,
    title,
    shareValue: BigInt(process.env.SHARE_VALUE ?? 1_000_000),
    minSharesPerDeposit: BigInt(process.env.MIN_SHARES ?? 1),
    maxSharesPerDeposit: BigInt(process.env.MAX_SHARES ?? 100),
    withdrawalPolicy: BigInt(process.env.WITHDRAWAL_POLICY ?? 0),
    ...(cycleEnd ? { cycleEnd } : {}),
    ...(process.env.QUORUM ? { quorum: process.env.QUORUM } : {}),
    ...(process.env.ASSET_POLICY
      ? {
          assetPolicy: process.env.ASSET_POLICY,
          assetName: process.env.ASSET_NAME ?? "",
        }
      : {}),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  saveState({ savingsFundTokenName: fundTokenName });
  console.log("Savings fund open. Token name:", fundTokenName);
  console.log("Members join with savings-join, then savings-deposit.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
