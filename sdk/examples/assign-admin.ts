/**
 * Assign Admin Example
 *
 * Transfers the group admin (222) token — and with it all admin authority —
 * to another address. ONE-WAY DOOR: the current admin cannot get it back
 * unless the new holder sends it back.
 *
 * The endpoint verifies the destination: sending the token to a script
 * address requires the script itself (proof someone can spend from it), so
 * authority is never stranded at an unspendable address. When the destination
 * is the multisig recorded by create-multisig, this script supplies it
 * automatically. FORCE=1 skips the check — only use it when you know exactly
 * what you are doing.
 *
 * Wallet selection:
 *   Default (ADMIN): uses ADMIN_SEED from .env — must hold the group 222 token
 *
 * Usage:
 *   NEW_ADMIN_ADDRESS=addr_test1... pnpm run assign-admin
 *   # multisig destination (run create-multisig first):
 *   NEW_ADMIN_ADDRESS=<state.json multisigAddress> pnpm run assign-admin
 */

import { getAddressDetails, Script } from "@lucid-evolution/lucid";
import { AssignAdminConfig } from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
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
  await selectEnvWallet(lucid, "ADMIN");

  const sdk = loadSdk();
  const state = loadState();
  const groupTokenSuffix =
    process.env.GROUP_TOKEN_SUFFIX ?? state.groupTokenSuffix;
  if (!groupTokenSuffix)
    throw new Error(
      "No groupTokenSuffix in state.json (and GROUP_TOKEN_SUFFIX not set). Run create-group first.",
    );

  const destinationAddress = process.env.NEW_ADMIN_ADDRESS;
  if (!destinationAddress)
    throw new Error(
      "NEW_ADMIN_ADDRESS is required. Example:\n" +
        "  NEW_ADMIN_ADDRESS=addr_test1... pnpm run assign-admin",
    );

  console.log("Transferring group admin authority to:", destinationAddress);
  console.log("This is a one-way door — the token leaves this wallet.");

  // Script destination: supply the multisig recorded by create-multisig as the
  // spendability proof. Without it the endpoint (correctly) refuses to strand
  // the authority token at a script address unless FORCE=1.
  let destinationScript: Script | undefined;
  const destCred = getAddressDetails(destinationAddress).paymentCredential;
  if (destCred?.type === "Script") {
    if (state.multisigScript && state.multisigHash === destCred.hash) {
      destinationScript = { type: "Native", script: state.multisigScript };
      console.log(
        "Destination is the recorded multisig — supplying the script as spendability proof.",
      );
    } else {
      console.log(
        "Destination is a script address with no matching multisig in state.json.",
      );
      console.log(
        "The endpoint will reject it unless FORCE=1 — run create-multisig first.",
      );
    }
  }

  const config: AssignAdminConfig = {
    groupTokenSuffix,
    destinationAddress,
    destinationScript,
    force: process.env.FORCE === "1",
  };

  console.log("Building assign-admin transaction...");
  const tx = await sdk.assignAdmin(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Admin authority transferred.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
