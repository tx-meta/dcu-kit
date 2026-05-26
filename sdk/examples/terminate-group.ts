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
  terminateGroup,
  TerminateGroupConfig,
  accountPolicyId,
  groupPolicyId,
} from "@tx-meta/dcu-sdk";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  logWalletInfo,
} from "./context.js";
import {
  loadState,
  checkValidatorStaleness,
  accountSuffixKey,
} from "./state.js";

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

  checkValidatorStaleness({ accountPolicyId, groupPolicyId: groupPolicyId! });

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
  const config: TerminateGroupConfig = {
    groupTokenSuffix,
    memberAccountTokenSuffix,
  };

  console.log("Building terminate transaction...");
  const tx = await terminateGroup(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
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
