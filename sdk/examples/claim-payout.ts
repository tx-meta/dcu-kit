/**
 * Claim Payout Example (Pull mode)
 *
 * Withdraws a member's earmarked payout from their own treasury UTxO. In a
 * Pull-mode group, distribute-payout does NOT send the pot to the borrower's
 * wallet — it accumulates it in the borrower's treasury as `claimable_balance`.
 * This example performs the final step: the member withdraws exactly that
 * earmark to a wallet of their choice. Collateral and the membership token
 * stay locked; `claimable_balance` resets to 0.
 *
 * Authorization is by possession of the member (222) token — NOT a stored
 * credential. A member who lost their original receiving wallet can still claim
 * from any wallet holding the token, to any destination. Set DESTINATION_ADDRESS
 * to claim to a fresh address (the lost-wallet recovery path); otherwise the
 * funds go to the signing wallet.
 *
 * Wallet selection (the wallet must hold the member 222 token):
 *   Default (USER1): uses USER1_SEED
 *   ACTIVE_WALLET=USER2: uses USER2_SEED
 *   ACTIVE_WALLET=ADMIN: uses ADMIN_SEED
 *
 * Optional:
 *   DESTINATION_ADDRESS=addr_test1... — claim to a fresh address (lost-wallet recovery).
 *
 * Reads accountTokenSuffix from state.json (keyed by active wallet).
 * Run create-group (with PAYOUT_MODE=Pull), join-group, start-group, and at least
 * one distribute-payout first so there is an earmark to claim.
 */

import {
  ClaimPayoutConfig,
  accountPolicyId,
  TreasuryDatum,
  assetNameLabels,
} from "@tx-meta/dcu-kit";
import { Data, UTxO } from "@lucid-evolution/lucid";
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
      "This example requires an active treasury with an earmarked payout.",
    );
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

  const sdk = loadSdk();
  const { groupPolicyId, treasuryPolicyId } = sdk.protocol;

  checkValidatorStaleness({ accountPolicyId, groupPolicyId });

  const state = loadState();
  const accountTokenSuffix = state[accountSuffixKey(activeWallet)];
  if (!accountTokenSuffix)
    throw new Error(
      `${accountSuffixKey(activeWallet)} not found in state.json.\n` +
        `Run: ACTIVE_WALLET=${activeWallet} pnpm run create-account`,
    );

  // Pre-flight: read the member's treasury datum to show what's claimable.
  const treasuryUnit =
    treasuryPolicyId + assetNameLabels.prefix222 + accountTokenSuffix;
  const treasuryUtxo = await lucid.utxoByUnit(treasuryUnit);
  if (!treasuryUtxo)
    throw new Error(
      `Treasury UTxO not found for ${activeWallet}. Has this member joined the group?`,
    );
  const treasuryDatum = Data.from(treasuryUtxo.datum!, TreasuryDatum);
  if (!("TreasuryState" in treasuryDatum)) {
    throw new Error(
      "Treasury is not in TreasuryState (likely DefaultState/PenaltyState) — nothing to claim.",
    );
  }
  const claimable = treasuryDatum.TreasuryState.claimable_balance;
  if (claimable <= 0n) {
    console.log(
      "Nothing to claim — claimable_balance is 0. Run distribute-payout on a Pull-mode group first.",
    );
    process.exit(0);
  }
  console.log(
    `Claimable earmark for ${activeWallet}: ${claimable} (contribution-asset units).`,
  );

  const destinationAddress = process.env.DESTINATION_ADDRESS;
  if (destinationAddress) {
    console.log(`Claiming to fresh address: ${destinationAddress}`);
  } else {
    console.log(
      "Claiming to the signing wallet (set DESTINATION_ADDRESS to redirect).",
    );
  }

  // Load the treasury reference script UTxO — keeps the tx under the size limit.
  // Deploy once with: pnpm run deploy-scripts
  const scriptRefs = await loadScriptRefs(lucid);

  const config: ClaimPayoutConfig = {
    accountTokenSuffix,
    destinationAddress,
    scriptRefs,
  };

  console.log("Building claim-payout transaction...");
  const tx = await sdk.claimPayout(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log(
    `Payout claimed! ${claimable} withdrawn; claimable_balance reset to 0.`,
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
