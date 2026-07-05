/**
 * Extend Grace Window Example
 *
 * Admin extends the grace period for a member who is in DefaultState (ICS).
 * ICS occurs when a member's treasury balance falls below contribution_fee after a payout
 * round. The member has until grace_expires_at to call contribute and top up their balance.
 *
 * This endpoint:
 *   - Increments grace_extensions_used by 1.
 *   - Extends grace_expires_at by one more grace_period_length.
 *   - Rejected on-chain once grace_extensions_used reaches max_grace_extensions (2).
 *
 * The group UTxO is used as a read-only reference input (not spent) to read
 * grace_period_length and verify admin identity via the group (222) token.
 *
 * Default wallet: ADMIN (must hold the group admin token).
 * MEMBER_WALLET:  identifies whose ICS treasury UTxO to extend (default: USER1).
 *   Override:  MEMBER_WALLET=USER2 pnpm run extend-grace-window
 *
 * Reads groupTokenSuffix and the member's accountTokenSuffix from state.json.
 */

import {
  ExtendGraceWindowConfig,
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
    console.log("This example requires a member in DefaultState.");
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  const adminSeed = process.env.ADMIN_SEED ?? process.env.USER1_SEED;
  if (!adminSeed) throw new Error("ADMIN_SEED not found in .env");
  lucid.selectWallet.fromSeed(adminSeed);
  await logWalletInfo(lucid, "ADMIN");

  const sdk = loadSdk();
  const { groupPolicyId } = sdk.protocol;

  checkValidatorStaleness({ accountPolicyId, groupPolicyId });

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
      `${accountSuffixKey(memberWallet)} not found in state.json.\n` +
        `Run: ACTIVE_WALLET=${memberWallet} pnpm run join-group`,
    );

  console.log(`Extending grace window for ${memberWallet}...`);
  console.log("Requires the member to be in DefaultState.");
  console.log(
    "The member should call 'pnpm run contribute' before grace_expires_at to exit ICS.",
  );

  // Script-held admin: attach the recorded multisig witness and co-sign below.
  // On the plain VK path adminAuth is empty and nothing changes.
  const adminUnit =
    groupPolicyId! + assetNameLabels.prefix222 + groupTokenSuffix;
  const adminAuth = await resolveAdminAuth(lucid, adminUnit);

  const config: ExtendGraceWindowConfig = {
    groupTokenSuffix,
    memberAccountTokenSuffix,
    scriptRefs: await loadScriptRefs(lucid),
    ...adminAuth.adminAuth,
  };

  console.log("Building extend-grace-window transaction...");
  const tx = await sdk.extendGraceWindow(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await signWithAdminAuth(lucid, tx, adminAuth);
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log(`Grace window extended for ${memberWallet}!`);
  console.log(
    `Run 'ACTIVE_WALLET=${memberWallet} pnpm run contribute' before the new grace_expires_at.`,
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
