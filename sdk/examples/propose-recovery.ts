/**
 * Propose Recovery Example
 *
 * Opens a lost-member recovery: rotates a lost identity N to a fresh one N'
 * after a quorum of members vouch and a timelock passes. The proposal names
 * the lost member (N), the recoveree's NEW account token (N'), the payment
 * credential future payouts will bind to, and the member quorum expected to
 * approve.
 *
 * Flow: propose-recovery → approve-recovery (each approver) →
 *       execute-recovery (after the timelock) — or cancel-recovery (veto by
 *       the original member N, proving the identity was never lost).
 *
 * Wallet selection:
 *   Default (USER2): must be the RECOVEREE's wallet — the one holding the fresh
 *   N' account token. The endpoint spends the N' UTxO, pays it back to the
 *   signing wallet, and binds new_payment_credential to the N' holder's key.
 *
 * Required env:
 *   TARGET_SUFFIX=...       the lost member's account token suffix (N)
 *   NEW_ACCOUNT_SUFFIX=...  the recoveree's fresh account token suffix (N') —
 *                           create it first with create-account on the new wallet
 *   NEW_PAYMENT_KEY_HASH=...the recoveree's payment key hash (from the new wallet)
 *   APPROVER_SUFFIXES=a,b   comma-separated account suffixes of the vouching quorum
 *   APPROVER_WALLETS=ADMIN  comma-separated wallet names (matching *_SEED vars) of
 *                           the same approvers — each account UTxO is spent, so
 *                           each approver co-signs this one tx
 *
 * Usage:
 *   TARGET_SUFFIX=... NEW_ACCOUNT_SUFFIX=... NEW_PAYMENT_KEY_HASH=... \
 *   APPROVER_SUFFIXES=... APPROVER_WALLETS=ADMIN pnpm run propose-recovery
 */

import { walletFromSeed } from "@lucid-evolution/lucid";
import { ProposeRecoveryConfig } from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
  loadScriptRefs,
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
  await selectEnvWallet(lucid, "USER2");

  const sdk = loadSdk();
  const state = loadState();
  const groupTokenSuffix =
    process.env.GROUP_TOKEN_SUFFIX ?? state.groupTokenSuffix;
  if (!groupTokenSuffix)
    throw new Error(
      "No groupTokenSuffix in state.json (and GROUP_TOKEN_SUFFIX not set). Run create-group first.",
    );

  const config: ProposeRecoveryConfig = {
    groupTokenSuffix,
    targetTokenSuffix: requiredEnv("TARGET_SUFFIX"),
    newAccountTokenSuffix: requiredEnv("NEW_ACCOUNT_SUFFIX"),
    newPaymentCredential: requiredEnv("NEW_PAYMENT_KEY_HASH"),
    approverTokenSuffixes: requiredEnv("APPROVER_SUFFIXES")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    scriptRefs: await loadScriptRefs(lucid),
  };
  console.log(
    `Proposing recovery of ${config.targetTokenSuffix.slice(0, 8)}... to ${config.newAccountTokenSuffix.slice(0, 8)}...`,
  );
  console.log(`Quorum: ${config.approverTokenSuffixes.length} approver(s)`);

  console.log("Building propose-recovery transaction...");
  const tx = await sdk.proposeRecovery(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  // Approver account UTxOs are spent, so each approver must witness this tx.
  // The sign builder captures the wallet at build time — co-sign with each
  // approver's raw payment key (same pattern as escrow-abort).
  const approverWallets = (process.env.APPROVER_WALLETS ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  let signing = tx.sign.withWallet();
  for (const wallet of approverWallets) {
    const seed = process.env[`${wallet}_SEED`];
    if (!seed) throw new Error(`${wallet}_SEED not found in .env`);
    const { paymentKey } = walletFromSeed(seed, {
      network: process.env.NETWORK === "Mainnet" ? "Mainnet" : "Preprod",
    });
    signing = signing.sign.withPrivateKey(paymentKey);
  }
  const signed = await signing.complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Recovery proposed.");
  console.log(
    "Each approver now runs approve-recovery; execute-recovery becomes valid after the timelock.",
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
