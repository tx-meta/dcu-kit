/**
 * Create Multisig Example
 *
 * Builds a native `atLeast M of N` multisig script over the payment keys of the
 * named example wallets and records it in state.json. No transaction is
 * submitted — the script address only becomes meaningful once something (e.g.
 * the group admin 222 token via assign-admin) is sent to it.
 *
 * The recorded script is what later steps use:
 *   - assign-admin passes it as `destinationScript` (spendability proof) when
 *     NEW_ADMIN_ADDRESS is this script's address
 *   - update-group / delete-group attach it as `adminScript` and co-sign with
 *     M of the signer wallets when the admin token is script-held
 *
 * Wallet selection:
 *   No wallet is selected — this script only derives key hashes from seeds.
 *
 * Env:
 *   SIGNER_WALLETS=ADMIN,USER1,USER2  wallet names (matching *_SEED vars) whose
 *                                     payment keys become the multisig signers
 *   REQUIRED_SIGNERS=2                M — how many of them must sign
 *
 * Usage:
 *   pnpm run create-multisig
 *   SIGNER_WALLETS=ADMIN,USER1 REQUIRED_SIGNERS=2 pnpm run create-multisig
 */

import { getAddressDetails, walletFromSeed } from "@lucid-evolution/lucid";
import { buildMultisig } from "@tx-meta/dcu-kit/multisig";
import { Effect } from "effect";
import { makeLucid, logError } from "./context.js";
import { saveState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  const signerWallets = (process.env.SIGNER_WALLETS ?? "ADMIN,USER1,USER2")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const required = Number(process.env.REQUIRED_SIGNERS ?? "2");

  const network = process.env.NETWORK === "Mainnet" ? "Mainnet" : "Preprod";
  const signers = signerWallets.map((wallet) => {
    const seed = process.env[`${wallet}_SEED`];
    if (!seed) throw new Error(`${wallet}_SEED not found in .env`);
    const { address } = walletFromSeed(seed, { network });
    const paymentCredential = getAddressDetails(address).paymentCredential;
    if (!paymentCredential || paymentCredential.type !== "Key")
      throw new Error(`${wallet}: could not derive a payment key hash`);
    return paymentCredential.hash;
  });

  console.log(
    `Building ${required}-of-${signerWallets.length} multisig over: ${signerWallets.join(", ")}`,
  );

  const multisig = await Effect.runPromise(
    buildMultisig(lucid, { signers, required }),
  );

  console.log("Multisig address:   ", multisig.address);
  console.log("Multisig hash:      ", multisig.policyHash);
  for (let i = 0; i < signerWallets.length; i++)
    console.log(`  signer ${signerWallets[i]}: ${signers[i]}`);

  saveState({
    multisigScript: multisig.script.script,
    multisigAddress: multisig.address,
    multisigHash: multisig.policyHash,
    multisigSignerWallets: signerWallets,
    multisigRequired: required,
  });

  console.log("\nNext steps:");
  console.log(
    `  NEW_ADMIN_ADDRESS=${multisig.address} pnpm run assign-admin`,
  );
  console.log(
    "  then update-group / delete-group detect the script-held admin token and",
  );
  console.log(
    `  co-sign with SIGNER_WALLETS (default: first ${required} of ${signerWallets.join(", ")}).`,
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
