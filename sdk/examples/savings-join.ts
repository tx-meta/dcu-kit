/**
 * Join Savings Fund Example
 *
 * Mints the member's CIP-68 capital-account pair against the fund saved in
 * state.json. The anchor is a reference input — joining never contends with
 * deposits. The (222) user token lands in the joining wallet and is the
 * spending authority for every later member action.
 *
 * Wallet selection: ACTIVE_WALLET joins (default USER1; run again with
 * ACTIVE_WALLET=USER2 for a second member).
 *
 * Env:
 *   CONSENT=true    standing-layer event-capture consent (default false)
 *
 * Usage:
 *   pnpm run savings-join
 *   ACTIVE_WALLET=USER2 pnpm run savings-join
 */

import { joinFund } from "@tx-meta/dcu-kit/savings";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, saveState, savingsSuffixKey } from "./state.js";

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
  if (!state.savingsFundTokenName) {
    throw new Error(
      "No savingsFundTokenName in state.json — run savings-create first.",
    );
  }

  console.log(`${wallet} joining fund ${state.savingsFundTokenName}`);
  const { tx, memberTokenSuffix } = await joinFund(lucid, {
    fundTokenName: state.savingsFundTokenName,
    consent: process.env.CONSENT === "true",
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  saveState({ [savingsSuffixKey(wallet)]: memberTokenSuffix });
  console.log("Member account minted. Suffix:", memberTokenSuffix);
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
