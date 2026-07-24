/**
 * B20 (P2 matrix): delete-account for a spare, membership-free account.
 *
 * Takes the account (222) suffix via ACCOUNT_SUFFIX and signs with ACTIVE_WALLET
 * (must hold the account tokens). Burns both CIP-68 account tokens. Mirrors
 * delete-account.ts but targets an explicit suffix rather than the per-wallet
 * state key.
 */
import { DeleteAccountConfig } from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log("Run on Preprod — requires an existing on-chain account.");
    process.exit(0);
  }
  const activeWallet = await selectEnvWallet(lucid, "ADMIN");

  const accountTokenSuffix = process.env.ACCOUNT_SUFFIX;
  if (!accountTokenSuffix) throw new Error("ACCOUNT_SUFFIX is required.");

  const sdk = loadSdk();
  const config: DeleteAccountConfig = { accountTokenSuffix };

  console.log(
    `Deleting account ${accountTokenSuffix.slice(0, 8)}... signed by ${activeWallet}`,
  );
  const tx = await sdk.deleteAccount(lucid, config).unsafeRun();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);
  console.log("Account deleted — both account tokens burned.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
