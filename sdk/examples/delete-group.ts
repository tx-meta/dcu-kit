/**
 * Delete Group Example
 *
 * Dissolves a deactivated, empty group: burns the group reference (100) and
 * admin (222) tokens, closes the mutual reserve, and returns all locked ADA
 * (including the creator bond) to the admin wallet as change.
 * Requires is_active === false (run update-group first) and member_count === 0.
 *
 * When the admin token is held at the multisig recorded by create-multisig,
 * the script attaches the multisig witness and co-signs with SIGNER_WALLETS.
 *
 * Token suffix resolution order:
 *   1. state.json (groupTokenSuffix) — set by create-group.ts
 *   2. Auto-discovery — scans admin wallet for a group admin token (222 prefix)
 */

import { DeleteGroupConfig, assetNameLabels } from "@tx-meta/dcu-kit";
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
  saveState,
  clearState,
  checkValidatorStaleness,
} from "./state.js";
import { resolveAdminAuth, signWithAdminAuth } from "./multisig-admin.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log("This example requires an existing on-chain group.");
    console.log(
      "These scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  const adminSeed = process.env.ADMIN_SEED ?? process.env.USER1_SEED;
  if (!adminSeed) throw new Error("ADMIN_SEED or USER1_SEED is required.");
  lucid.selectWallet.fromSeed(adminSeed);
  await logWalletInfo(lucid, "ADMIN");

  const sdk = loadSdk();
  const { groupPolicyId } = sdk.protocol;

  checkValidatorStaleness({ groupPolicyId });

  let { groupTokenSuffix } = loadState();

  if (!groupTokenSuffix) {
    console.log(
      "groupTokenSuffix not in state.json — scanning admin wallet for group admin token...",
    );
    const walletUtxos = await lucid.wallet().getUtxos();
    const adminUtxo = walletUtxos.find((u) =>
      Object.keys(u.assets).some(
        (k) =>
          k.startsWith(groupPolicyId!) &&
          k.slice(groupPolicyId!.length).startsWith(assetNameLabels.prefix222),
      ),
    );
    if (!adminUtxo)
      throw new Error(
        "No group admin token (222) found in wallet and no groupTokenSuffix in state.json.\n" +
          "Run create-group.ts first.",
      );
    const key = Object.keys(adminUtxo.assets).find(
      (k) =>
        k.startsWith(groupPolicyId!) &&
        k.slice(groupPolicyId!.length).startsWith(assetNameLabels.prefix222),
    )!;
    groupTokenSuffix = key.slice(
      groupPolicyId!.length + assetNameLabels.prefix222.length,
    );
    console.log("Found groupTokenSuffix:", groupTokenSuffix);
    saveState({ groupTokenSuffix });
  }

  // Script-held admin: attach the recorded multisig witness and co-sign below.
  // On the plain VK path adminAuth is empty and nothing changes.
  const adminUnit =
    groupPolicyId! + assetNameLabels.prefix222 + groupTokenSuffix;
  const adminAuth = await resolveAdminAuth(lucid, adminUnit);

  const config: DeleteGroupConfig = {
    groupTokenSuffix,
    scriptRefs: await loadScriptRefs(lucid),
    ...adminAuth.adminAuth,
  };

  console.log("Building transaction...");
  const tx = await sdk.deleteGroup(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await signWithAdminAuth(lucid, tx, adminAuth);
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  clearState(["groupTokenSuffix"]);
  console.log("Group deleted — both group tokens burned.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
