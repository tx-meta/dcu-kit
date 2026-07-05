/**
 * Terminate Group Example
 *
 * Admin claims a PenaltyState treasury UTxO left by a member who exited early.
 * Burns the membership token and releases the locked ADA to the admin wallet.
 *
 * Reads groupTokenSuffix and accountTokenSuffix from state.json.
 * Requires a PenaltyState treasury UTxO to exist — run exit-group.ts (early exit) first.
 */

import {
  TerminateGroupConfig,
  accountPolicyId,
  assetNameLabels,
} from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  logWalletInfo,
  loadScriptRefs,
} from "./context.js";
import {
  loadState,
  checkValidatorStaleness,
  accountSuffixKey,
} from "./state.js";
import { resolveAdminAuth, signWithAdminAuth } from "./multisig-admin.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log(
      "This example requires a PenaltyState treasury UTxO (created by an early exit).",
    );
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  const adminSeed = process.env.ADMIN_SEED ?? process.env.USER1_SEED;
  if (!adminSeed) throw new Error("ADMIN_SEED or USER1_SEED is required.");
  lucid.selectWallet.fromSeed(adminSeed);
  await logWalletInfo(lucid, "ADMIN");

  const sdk = loadSdk();
  const { groupPolicyId } = sdk.protocol;

  checkValidatorStaleness({ accountPolicyId, groupPolicyId });

  // MEMBER_WALLET identifies whose PenaltyState UTxO to claim (default: USER1).
  // Set MEMBER_WALLET=USER2 if USER2 exited early and you want to claim their penalty.
  const memberWallet = (process.env.MEMBER_WALLET ?? "USER1").toUpperCase();
  const state = loadState();
  const { groupTokenSuffix } = state;
  const memberAccountTokenSuffix = state[accountSuffixKey(memberWallet)];
  if (!groupTokenSuffix)
    throw new Error(
      "groupTokenSuffix not found in state.json. Run create-group.ts first.",
    );
  if (!memberAccountTokenSuffix)
    throw new Error(
      `${accountSuffixKey(memberWallet)} not found in state.json. Run join-group.ts as ${memberWallet} first.`,
    );

  console.log(`Claiming PenaltyState from ${memberWallet}'s early exit...`);

  // Script-held admin: attach the recorded multisig witness and co-sign below.
  // On the plain VK path adminAuth is empty and nothing changes.
  const adminUnit =
    groupPolicyId! + assetNameLabels.prefix222 + groupTokenSuffix;
  const adminAuth = await resolveAdminAuth(lucid, adminUnit);

  const config: TerminateGroupConfig = {
    groupTokenSuffix,
    memberAccountTokenSuffix,
    scriptRefs: await loadScriptRefs(lucid),
    ...adminAuth.adminAuth,
  };

  console.log("Building terminate transaction...");
  const tx = await sdk.terminateGroup(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await signWithAdminAuth(lucid, tx, adminAuth);
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Penalty withdrawn successfully!");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
