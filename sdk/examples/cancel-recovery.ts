/**
 * Cancel Recovery Example
 *
 * Vetoes a pending recovery request. Run by the ORIGINAL member (N): spending
 * with their account token proves the identity was never lost, and the
 * request dissolves.
 *
 * Wallet selection:
 *   Default (USER1): the original member — their wallet must hold the account
 *   (222) token named by the request; the suffix is discovered automatically
 *   (override with TARGET_SUFFIX=...).
 *
 * Required env:
 *   NEW_ACCOUNT_SUFFIX=...  the pending request's new account suffix (N')
 *
 * Usage:
 *   NEW_ACCOUNT_SUFFIX=... pnpm run cancel-recovery
 */

import { CancelRecoveryConfig } from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
  loadScriptRefs,
  discoverAccountSuffix,
} from "./context.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  const wallet = await selectEnvWallet(lucid, "USER1");

  const sdk = loadSdk();

  const targetTokenSuffix =
    process.env.TARGET_SUFFIX ?? (await discoverAccountSuffix(lucid));
  if (!targetTokenSuffix)
    throw new Error(
      `No account (222) token found in the ${wallet} wallet — the veto must come from the original member.`,
    );

  const newAccountTokenSuffix = process.env.NEW_ACCOUNT_SUFFIX;
  if (!newAccountTokenSuffix)
    throw new Error("NEW_ACCOUNT_SUFFIX is required — see the header comment.");

  const config: CancelRecoveryConfig = {
    targetTokenSuffix,
    newAccountTokenSuffix,
    scriptRefs: await loadScriptRefs(lucid),
  };
  console.log(
    `Vetoing recovery request ${newAccountTokenSuffix.slice(0, 8)}... as ${targetTokenSuffix.slice(0, 8)}...`,
  );

  console.log("Building cancel-recovery transaction...");
  const tx = await sdk.cancelRecovery(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Recovery request cancelled.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
