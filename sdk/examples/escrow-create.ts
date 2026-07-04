/**
 * Create Escrow Example
 *
 * Locks funds into a milestone escrow. The verifier is an AUTHORITY, never a
 * custodian: they can release tranches to the beneficiary, but can never take
 * the funds. Releases stop at expiry; strictly after it the funder reclaims
 * whatever remains.
 *
 * Wallet selection:
 *   Default (USER1): the funder
 *
 * Env:
 *   BENEFICIARY_ADDRESS=addr_test1...  required — tranche destination
 *   MILESTONES=2000000,3000000         tranche amounts in lovelace (default shown)
 *   EXPIRY_DAYS=30                     reclaim opens this many days from now
 *   VERIFIER_KEY_HASH=...              release authority (defaults to the
 *                                      funder's own key — fine for a demo,
 *                                      pointless in production)
 *
 * Usage:
 *   BENEFICIARY_ADDRESS=addr_test1... pnpm run escrow-create
 */

import { getAddressDetails } from "@lucid-evolution/lucid";
import { CreateEscrowConfig, createEscrow } from "@tx-meta/dcu-kit/escrow";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { saveState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const beneficiaryAddress = process.env.BENEFICIARY_ADDRESS;
  if (!beneficiaryAddress)
    throw new Error(
      "BENEFICIARY_ADDRESS is required. Example:\n" +
        "  BENEFICIARY_ADDRESS=addr_test1... pnpm run escrow-create",
    );

  const milestones = (process.env.MILESTONES ?? "2000000,3000000")
    .split(",")
    .map((s) => BigInt(s.trim()));
  const expiryDays = Number(process.env.EXPIRY_DAYS ?? "30");
  const expiry = BigInt(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  let verifierHash = process.env.VERIFIER_KEY_HASH;
  if (!verifierHash) {
    const ownAddress = await lucid.wallet().address();
    verifierHash = getAddressDetails(ownAddress).paymentCredential!.hash;
    console.warn(
      "VERIFIER_KEY_HASH not set — using the funder's own key as verifier (demo only).",
    );
  }

  const total = milestones.reduce((a, b) => a + b, 0n);
  console.log(
    `Escrow: ${milestones.length} milestone(s), ${total / 1_000_000n} ADA total, expires in ${expiryDays} day(s).`,
  );

  const config: CreateEscrowConfig = {
    beneficiaryAddress,
    verifier: { type: "Key", hash: verifierHash },
    milestones,
    expiry,
  };

  console.log("Building create-escrow transaction...");
  const { tx, stateTokenName } = await createEscrow(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  saveState({ escrowStateTokenName: stateTokenName });
  console.log("Escrow created. State token:", stateTokenName);
  console.log(
    "Saved to state.json — escrow-release/reclaim/abort/inspect use it automatically.",
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
