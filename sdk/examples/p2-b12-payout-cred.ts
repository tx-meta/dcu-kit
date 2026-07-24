/**
 * B12 (P2 matrix): update-payout-credential on a directly-driven member.
 *
 * The recommit group's members were created outside the standard per-wallet
 * state keys, so this driver takes the account (222) suffix via ACCOUNT_SUFFIX
 * and signs with ACTIVE_WALLET (must be the member's current wallet — the
 * validator re-derives and verifies the credential from the signer). Mirrors
 * update-payout-credential.ts otherwise.
 */
import { UpdatePayoutCredentialConfig } from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
  loadScriptRefs,
} from "./context.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log("Run on Preprod — requires existing on-chain membership.");
    process.exit(0);
  }
  const activeWallet = await selectEnvWallet(lucid, "ADMIN");

  const accountTokenSuffix = process.env.ACCOUNT_SUFFIX;
  if (!accountTokenSuffix) throw new Error("ACCOUNT_SUFFIX is required.");

  const sdk = loadSdk();
  const config: UpdatePayoutCredentialConfig = {
    accountTokenSuffix,
    scriptRefs: await loadScriptRefs(lucid),
  };

  console.log(
    `Updating payout credential for account ${accountTokenSuffix.slice(0, 8)}... signed by ${activeWallet}`,
  );
  const tx = await sdk.updatePayoutCredential(lucid, config).unsafeRun();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);
  console.log("Payout credential updated.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
