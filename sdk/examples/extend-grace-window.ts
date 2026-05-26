/**
 * Extend Grace Window Example
 *
 * Admin extends the grace period for a member who is in InsufficientCollateralState (ICS).
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
  extendGraceWindow,
  ExtendGraceWindowConfig,
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
      "This example requires a member in InsufficientCollateralState.",
    );
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  const adminSeed = process.env.ADMIN_SEED ?? process.env.USER1_SEED;
  if (!adminSeed) throw new Error("ADMIN_SEED not found in .env");
  lucid.selectWallet.fromSeed(adminSeed);
  await logWalletInfo(lucid, "ADMIN");

  checkValidatorStaleness({ accountPolicyId, groupPolicyId: groupPolicyId! });

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
  console.log("Requires the member to be in InsufficientCollateralState.");
  console.log(
    "The member should call 'pnpm run contribute' before grace_expires_at to exit ICS.",
  );

  const config: ExtendGraceWindowConfig = {
    groupTokenSuffix,
    memberAccountTokenSuffix,
  };

  console.log("Building extend-grace-window transaction...");
  const tx = await extendGraceWindow(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
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
