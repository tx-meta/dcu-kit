/**
 * Resolve Dispute (V2) Example
 *
 * The arbiter settles a disputed escrow with a TERMINAL split of the whole
 * remaining balance between funder and beneficiary — the validator forbids
 * paying anyone else (including the arbiter). Burns the state token.
 *
 * Wallet selection: ACTIVE_WALLET must be the arbiter (default ADMIN).
 *
 * Env:
 *   FUNDER_LOVELACE=2000000     funder's share; the rest goes to the beneficiary
 *   ESCROW_V2_STATE_TOKEN=...   overrides state.json
 *
 * Usage:
 *   ACTIVE_WALLET=ADMIN FUNDER_LOVELACE=2000000 pnpm run escrow-v2-resolve
 */

import { Effect } from "effect";
import {
  resolveDispute,
  getEscrowStateProgram,
} from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";
import { requireToken } from "./escrow-v2-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "ADMIN");

  const stateTokenName = requireToken(
    "ESCROW_V2_STATE_TOKEN",
    loadState().escrowV2StateTokenName,
    "run escrow-v2-create first.",
  );

  const s = await Effect.runPromise(
    getEscrowStateProgram(lucid, { stateTokenName }),
  );
  const funderAmount = BigInt(process.env.FUNDER_LOVELACE ?? "0");
  const beneficiaryAmount = s.lockedBalance - funderAmount;
  if (beneficiaryAmount < 0n)
    throw new Error(
      `FUNDER_LOVELACE exceeds the locked balance (${s.lockedBalance}).`,
    );

  console.log(
    `Arbiter ruling: ${Number(funderAmount) / 1e6} ADA to funder, ` +
      `${Number(beneficiaryAmount) / 1e6} ADA to beneficiary.`,
  );
  const tx = await resolveDispute(lucid, {
    stateTokenName,
    funderAmount,
    beneficiaryAmount,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Dispute resolved — terminal split executed, escrow closed.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
