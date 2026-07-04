/**
 * Abort Escrow Example
 *
 * Ends the escrow early by MUTUAL CONSENT: funder and beneficiary both sign
 * one transaction distributing the remaining balance however they agreed.
 * The verifier is not involved — authority-only, never a custodian.
 *
 * Wallet selection:
 *   Default (USER1): the funder. The beneficiary co-signs in the same run via
 *   COSIGNER_SEED (their seed phrase must be available to this process).
 *
 * Env:
 *   COSIGNER_SEED="..."               required — the beneficiary's seed
 *   BENEFICIARY_ADDRESS=addr_test...  required — where their share goes
 *   BENEFICIARY_LOVELACE=1000000      beneficiary's share; the rest of the
 *                                     balance refunds to the funder
 *   ESCROW_STATE_TOKEN=...            overrides state.json
 *
 * Usage:
 *   COSIGNER_SEED="word1 word2 ..." BENEFICIARY_ADDRESS=addr_test1... \
 *   BENEFICIARY_LOVELACE=1000000 pnpm run escrow-abort
 */

import { Effect } from "effect";
import {
  AbortEscrowConfig,
  abortEscrow,
  getEscrowStateProgram,
} from "@tx-meta/dcu-kit/escrow";
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
  await selectEnvWallet(lucid, "USER1");
  const funderAddress = await lucid.wallet().address();

  const cosignerSeed = process.env.COSIGNER_SEED;
  const beneficiaryAddress = process.env.BENEFICIARY_ADDRESS;
  if (!cosignerSeed || !beneficiaryAddress)
    throw new Error(
      "COSIGNER_SEED and BENEFICIARY_ADDRESS are required — abort is mutual consent, both parties sign.",
    );

  const stateTokenName =
    process.env.ESCROW_STATE_TOKEN ?? loadState().escrowStateTokenName;
  if (!stateTokenName)
    throw new Error(
      "No escrowStateTokenName in state.json (and ESCROW_STATE_TOKEN not set). Run escrow-create first.",
    );

  const escrow = await Effect.runPromise(
    getEscrowStateProgram(lucid, { stateTokenName }),
  );
  const beneficiaryShare = BigInt(process.env.BENEFICIARY_LOVELACE ?? "0");
  const funderShare = escrow.remainingBalance - beneficiaryShare;
  if (funderShare < 0n)
    throw new Error(
      `BENEFICIARY_LOVELACE exceeds the remaining balance (${escrow.remainingBalance}).`,
    );
  console.log(
    `Aborting: ${beneficiaryShare} to beneficiary, ${funderShare} back to funder.`,
  );

  const config: AbortEscrowConfig = {
    stateTokenName,
    payouts: [
      { address: funderAddress, assets: { lovelace: funderShare } },
      { address: beneficiaryAddress, assets: { lovelace: beneficiaryShare } },
    ].filter((p) => p.assets.lovelace > 0n),
  };

  console.log("Building abort transaction...");
  const tx = await abortEscrow(lucid, config).unsafeRun();

  console.log("Collecting both signatures...");
  const funderWitness = await tx.partialSign.withWallet();
  lucid.selectWallet.fromSeed(cosignerSeed);
  const beneficiaryWitness = await tx.partialSign.withWallet();
  const signed = await tx
    .assemble([funderWitness, beneficiaryWitness])
    .complete();

  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Escrow aborted by mutual consent.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
