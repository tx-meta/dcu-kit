/**
 * Contribute Example
 *
 * Tops up a member's treasury UTxO balance by adding ADA without changing
 * any other datum fields. Used when a member's balance is running low
 * (but they are still in TreasuryState — not yet in DefaultState).
 *
 * Wallet selection:
 *   Default (USER1): uses USER1_SEED
 *   ACTIVE_WALLET=USER2: uses USER2_SEED
 *   ACTIVE_WALLET=ADMIN: uses ADMIN_SEED
 *
 * Top-up amount:
 *   Defaults to 5 ADA. Override with: TOP_UP_AMOUNT=<lovelace>
 *   Example: TOP_UP_AMOUNT=10000000 pnpm run contribute
 *
 * Reads accountTokenSuffix from state.json (keyed by active wallet).
 * Requires the Account NFT to be in the active wallet.
 */

import {
  contribute,
  ContributeConfig,
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

const DEFAULT_TOP_UP_LOVELACE = 5_000_000n; // 5 ADA

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log("This example requires an active treasury membership.");
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  const activeWallet = (process.env.ACTIVE_WALLET ?? "USER1").toUpperCase();
  const walletSeed =
    process.env[`${activeWallet}_SEED`] ?? process.env.USER1_SEED;
  if (!walletSeed) throw new Error(`${activeWallet}_SEED not found in .env`);
  lucid.selectWallet.fromSeed(walletSeed);
  await logWalletInfo(lucid, activeWallet);

  checkValidatorStaleness({ accountPolicyId, groupPolicyId: groupPolicyId! });

  const topUpAmount = process.env.TOP_UP_AMOUNT
    ? BigInt(process.env.TOP_UP_AMOUNT)
    : DEFAULT_TOP_UP_LOVELACE;

  const state = loadState();
  const accountTokenSuffix = state[accountSuffixKey(activeWallet)];
  if (!accountTokenSuffix)
    throw new Error(
      `${accountSuffixKey(activeWallet)} not found in state.json.\n` +
        `Run: ACTIVE_WALLET=${activeWallet} pnpm run create-account`,
    );

  console.log(
    `Topping up ${activeWallet}'s treasury UTxO by ${topUpAmount / 1_000_000n} ADA...`,
  );
  console.log(
    "Note: only valid when the treasury UTxO is in TreasuryState (not DefaultState).",
  );

  const config: ContributeConfig = {
    accountTokenSuffix,
    topUpAmount,
  };

  console.log("Building contribute transaction...");
  const tx = await contribute(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log(
    `Top-up confirmed! ${activeWallet}'s treasury balance increased by ${topUpAmount / 1_000_000n} ADA.`,
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
