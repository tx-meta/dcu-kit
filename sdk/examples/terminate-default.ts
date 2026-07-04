/**
 * Terminate Default Example
 *
 * Admin removes a member stuck in DefaultState whose grace window (including any
 * extensions) has fully expired. Burns the membership token, decrements the group's
 * member_count, and forfeits the locked collateral to the admin wallet.
 *
 * Requires a DefaultState treasury UTxO to exist and its grace_expires_at to be in the
 * past. A member enters DefaultState when a distribute round drops their contributable
 * balance below contribution_fee (e.g. a PerRound member who does not top up via
 * contribute). Reads groupTokenSuffix + the member's account suffix from state.json.
 */

import { TerminateDefaultConfig, accountPolicyId } from "@tx-meta/dcu-kit";
import { UTxO } from "@lucid-evolution/lucid";
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

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log(
      "This example requires a DefaultState treasury UTxO past its grace window.",
    );
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  // Termination is admin-only — the admin wallet holds the group (222) token.
  const adminSeed = process.env.ADMIN_SEED ?? process.env.USER1_SEED;
  if (!adminSeed) throw new Error("ADMIN_SEED or USER1_SEED is required.");
  lucid.selectWallet.fromSeed(adminSeed);
  await logWalletInfo(lucid, "ADMIN");

  const sdk = loadSdk();
  const { groupPolicyId } = sdk.protocol;

  checkValidatorStaleness({ accountPolicyId, groupPolicyId });

  // MEMBER_WALLET identifies whose DefaultState UTxO to terminate (default: USER1).
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

  // Load reference script UTxOs to keep the terminate tx under 16KB (it spends the
  // group + treasury and burns, so it is too large to inline both validators).
  const scriptRefs = await loadScriptRefs(lucid);

  console.log(
    `Terminating ${memberWallet}'s DefaultState membership (grace expired)...`,
  );
  const config: TerminateDefaultConfig = {
    groupTokenSuffix,
    memberAccountTokenSuffix,
    scriptRefs,
  };

  console.log("Building terminate-default transaction...");
  const tx = await sdk.terminateDefault(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Defaulter terminated successfully! member_count decremented.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
