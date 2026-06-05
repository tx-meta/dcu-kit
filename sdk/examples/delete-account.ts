/**
 * Delete Account Example
 *
 * Burns both CIP-68 account tokens, permanently removing the DCU account.
 * The account must have no active group memberships — exit all groups first.
 *
 * Token suffix resolution order:
 *   1. state.json (accountTokenSuffix) — set by create-account.ts
 *   2. Auto-discovery — scans the wallet for an account auth token (222 prefix)
 */

import {
  DeleteAccountConfig,
  accountPolicyId,
  assetNameLabels,
} from "@tx-meta/dcu-sdk";
import { loadSdk } from "./sdk.js";
import { makeLucid, cexplorerTxUrl, logError } from "./context.js";
import {
  loadState,
  saveState,
  clearState,
  checkValidatorStaleness,
  accountSuffixKey,
} from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log("This example requires an existing on-chain account.");
    console.log(
      "These scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  const sdk = loadSdk();

  checkValidatorStaleness({ accountPolicyId });

  // Select which wallet/account to act on from ACTIVE_WALLET (mirrors join-group), so the
  // signing wallet and the resolved account suffix always belong to the same member.
  const activeWallet = (process.env.ACTIVE_WALLET ?? "USER1").toUpperCase();
  const walletSeed = process.env[`${activeWallet}_SEED`] ?? process.env.USER1_SEED;
  if (!walletSeed) throw new Error(`${activeWallet}_SEED not found in .env`);
  lucid.selectWallet.fromSeed(walletSeed);

  const suffixKey = accountSuffixKey(activeWallet);
  let accountTokenSuffix = loadState()[suffixKey];

  if (!accountTokenSuffix) {
    console.log(
      "accountTokenSuffix not in state.json — scanning wallet for account auth token...",
    );
    const walletUtxos = await lucid.wallet().getUtxos();
    const authUtxo = walletUtxos.find((u) =>
      Object.keys(u.assets).some(
        (k) =>
          k.startsWith(accountPolicyId) &&
          k.slice(accountPolicyId.length).startsWith(assetNameLabels.prefix222),
      ),
    );
    if (!authUtxo)
      throw new Error(
        "No account auth token (222) found in wallet and no accountTokenSuffix in state.json.\n" +
          "Run create-account.ts first.",
      );
    const key = Object.keys(authUtxo.assets).find(
      (k) =>
        k.startsWith(accountPolicyId) &&
        k.slice(accountPolicyId.length).startsWith(assetNameLabels.prefix222),
    )!;
    accountTokenSuffix = key.slice(
      accountPolicyId.length + assetNameLabels.prefix222.length,
    );
    console.log("Found accountTokenSuffix:", accountTokenSuffix);
    saveState({ [suffixKey]: accountTokenSuffix });
  }

  const config: DeleteAccountConfig = {
    accountTokenSuffix,
  };

  console.log("Building transaction...");
  const tx = await sdk.deleteAccount(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  clearState([suffixKey]);
  console.log("Account deleted successfully!");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
