/**
 * Begin Recommit Example
 *
 * Opens the group's recommit window (admin only). While the window is open,
 * distribution pauses, joining re-opens, and every exit is free — the group
 * re-seals with `start-group` after at least `recommit_window` ms.
 *
 * The on-chain gate is objective: every member clean (nobody mid-default),
 * the reserve owes no pending stand-in cover, and the rotation stands at a
 * lap boundary or a provable vacant-slot halt.
 *
 * Wallet selection:
 *   Default (ADMIN): uses ADMIN_SEED from .env — must hold the group 222 token
 *
 * Usage:
 *   pnpm run begin-recommit
 */

import { BeginRecommitConfig, assetNameLabels } from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
  loadScriptRefs,
} from "./context.js";
import { loadState } from "./state.js";
import { resolveAdminAuth, signWithAdminAuth } from "./multisig-admin.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "ADMIN");

  const sdk = loadSdk();
  const state = loadState();
  const groupTokenSuffix =
    process.env.GROUP_TOKEN_SUFFIX ?? state.groupTokenSuffix;
  if (!groupTokenSuffix)
    throw new Error(
      "No groupTokenSuffix in state.json (and GROUP_TOKEN_SUFFIX not set). Run create-group first.",
    );

  const scriptRefs = await loadScriptRefs(lucid);

  // Script-held admin: attach the recorded multisig witness and co-sign below.
  // On the plain VK path adminAuth is empty and nothing changes.
  const adminUnit =
    sdk.protocol.groupPolicyId + assetNameLabels.prefix222 + groupTokenSuffix;
  const adminAuth = await resolveAdminAuth(lucid, adminUnit);

  const config: BeginRecommitConfig = {
    groupTokenSuffix,
    scriptRefs,
    ...adminAuth.adminAuth,
  };

  console.log("Building begin-recommit transaction...");
  const tx = await sdk.beginRecommit(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await signWithAdminAuth(lucid, tx, adminAuth);
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Recommit window is open.");
  console.log(
    "Members may now join or exit freely; re-seal with 'pnpm run start-group'",
  );
  console.log("after the recommit window has elapsed.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
