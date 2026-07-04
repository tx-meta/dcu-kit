/**
 * Execute Recovery Example
 *
 * Finalizes an approved recovery after its timelock: the group registry swaps
 * the lost identity N for N' in place (slot preserved), and the member's
 * treasury re-binds to the recoveree's payment credential.
 *
 * Wallet selection:
 *   Default (USER1): the recoveree — their wallet holds the NEW account (222)
 *   token; the suffix is discovered from the wallet automatically (override
 *   with NEW_ACCOUNT_SUFFIX=...).
 *
 * Required env:
 *   TARGET_SUFFIX=...  the lost member's account token suffix (N)
 *
 * Usage:
 *   TARGET_SUFFIX=... pnpm run execute-recovery
 */

import { ExecuteRecoveryConfig } from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
  loadScriptRefs,
  discoverAccountSuffix,
} from "./context.js";
import { loadState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  const wallet = await selectEnvWallet(lucid, "USER1");

  const sdk = loadSdk();
  const state = loadState();
  const groupTokenSuffix =
    process.env.GROUP_TOKEN_SUFFIX ?? state.groupTokenSuffix;
  if (!groupTokenSuffix)
    throw new Error(
      "No groupTokenSuffix in state.json (and GROUP_TOKEN_SUFFIX not set). Run create-group first.",
    );

  const targetTokenSuffix = process.env.TARGET_SUFFIX;
  if (!targetTokenSuffix)
    throw new Error("TARGET_SUFFIX is required — see the header comment.");

  const newAccountTokenSuffix =
    process.env.NEW_ACCOUNT_SUFFIX ?? (await discoverAccountSuffix(lucid));
  if (!newAccountTokenSuffix)
    throw new Error(
      `No account (222) token found in the ${wallet} wallet — run this from the recoveree's wallet.`,
    );

  const config: ExecuteRecoveryConfig = {
    groupTokenSuffix,
    targetTokenSuffix,
    newAccountTokenSuffix,
    scriptRefs: await loadScriptRefs(lucid),
  };
  console.log(
    `Executing recovery: ${targetTokenSuffix.slice(0, 8)}... → ${newAccountTokenSuffix.slice(0, 8)}...`,
  );

  console.log("Building execute-recovery transaction...");
  const tx = await sdk.executeRecovery(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Recovery executed — the registry now carries the new identity.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
