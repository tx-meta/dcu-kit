/**
 * Abort Escrow (V2) Example
 *
 * Ends the escrow early by MUTUAL CONSENT: funder and beneficiary co-sign one
 * transaction distributing the remaining balance however they agreed. Works
 * at any time — even during a dispute freeze. Burns the state token.
 *
 * Wallet selection: ACTIVE_WALLET is the funder (default USER1); the
 * beneficiary co-signs in the same run via COSIGNER (a .env wallet name).
 *
 * Env:
 *   COSIGNER=USER2                  the beneficiary wallet name (required)
 *   BENEFICIARY_LOVELACE=1000000    beneficiary's share; rest refunds funder
 *   ESCROW_V2_STATE_TOKEN=...       overrides state.json
 *
 * Usage:
 *   COSIGNER=USER2 BENEFICIARY_LOVELACE=1000000 pnpm run escrow-v2-abort
 */

import { Effect } from "effect";
import {
  abortEscrow,
  getEscrowStateProgram,
  AbortEscrowV2Config,
} from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";
import { envWalletPaymentKey, requireToken } from "./escrow-v2-common.js";

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

  const cosigner = process.env.COSIGNER;
  if (!cosigner)
    throw new Error(
      "COSIGNER (the beneficiary wallet name) is required — abort is mutual consent.",
    );

  const stateTokenName = requireToken(
    "ESCROW_V2_STATE_TOKEN",
    loadState().escrowV2StateTokenName,
    "run escrow-v2-create first.",
  );

  const s = await Effect.runPromise(
    getEscrowStateProgram(lucid, { stateTokenName }),
  );
  const beneficiaryShare = BigInt(process.env.BENEFICIARY_LOVELACE ?? "0");
  const funderShare = s.lockedBalance - beneficiaryShare;
  if (funderShare < 0n)
    throw new Error(
      `BENEFICIARY_LOVELACE exceeds the locked balance (${s.lockedBalance}).`,
    );
  console.log(
    `Aborting: ${Number(beneficiaryShare) / 1e6} ADA to beneficiary, ${Number(funderShare) / 1e6} ADA back to funder.`,
  );

  const config: AbortEscrowV2Config = {
    stateTokenName,
    payouts: [
      { address: funderAddress, assets: { lovelace: funderShare } },
      { address: s.beneficiaryAddress, assets: { lovelace: beneficiaryShare } },
    ].filter((p) => p.assets.lovelace > 0n),
  };

  console.log("Building abort transaction...");
  const tx = await abortEscrow(lucid, config).unsafeRun();

  console.log("Collecting both signatures...");
  const signed = await tx.sign
    .withWallet()
    .sign.withPrivateKey(envWalletPaymentKey(cosigner))
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
