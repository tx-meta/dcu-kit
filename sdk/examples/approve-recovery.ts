/**
 * Approve Recovery Example
 *
 * A quorum member vouches for a pending recovery request. Run once per
 * approver, each from their own wallet.
 *
 * Wallet selection:
 *   Default (USER1): the approver — their wallet must hold their account
 *   (222) token; the suffix is discovered from the wallet automatically
 *   (override with APPROVER_SUFFIX=...).
 *
 * Required env:
 *   TARGET_SUFFIX=...       the lost member's account token suffix (N)
 *   NEW_ACCOUNT_SUFFIX=...  the pending request's new account suffix (N')
 *
 * Usage:
 *   TARGET_SUFFIX=... NEW_ACCOUNT_SUFFIX=... pnpm run approve-recovery
 *   ACTIVE_WALLET=USER2 TARGET_SUFFIX=... NEW_ACCOUNT_SUFFIX=... pnpm run approve-recovery
 */

import { ApproveRecoveryConfig } from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
  loadScriptRefs,
  discoverAccountSuffix,
} from "./context.js";
import { loadState } from "./state.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required — see the header comment.`);
  return value;
}

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
  const state = loadState();
  const groupTokenSuffix =
    process.env.GROUP_TOKEN_SUFFIX ?? state.groupTokenSuffix;
  if (!groupTokenSuffix)
    throw new Error(
      "No groupTokenSuffix in state.json (and GROUP_TOKEN_SUFFIX not set). Run create-group first.",
    );

  const approverTokenSuffix =
    process.env.APPROVER_SUFFIX ?? (await discoverAccountSuffix(lucid));
  if (!approverTokenSuffix)
    throw new Error(
      `No account (222) token found in the ${wallet} wallet — approvers must be members.`,
    );
  console.log(`Approving as ${approverTokenSuffix.slice(0, 8)}...`);

  const config: ApproveRecoveryConfig = {
    groupTokenSuffix,
    targetTokenSuffix: requiredEnv("TARGET_SUFFIX"),
    newAccountTokenSuffix: requiredEnv("NEW_ACCOUNT_SUFFIX"),
    approverTokenSuffix,
    scriptRefs: await loadScriptRefs(lucid),
  };

  console.log("Building approve-recovery transaction...");
  const tx = await sdk.approveRecovery(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Approval recorded.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
