/**
 * Rotate Party (V2) Example
 *
 * ONE party of the escrow replaces its own credential — wallet migration, a
 * verifier handing off, the beneficiary assigning the receivable, or a
 * co-beneficiary moving its payout address. Only the CURRENT credential of
 * the rotated party can authorize it; nobody can replace anyone else.
 *
 * Wallet selection: ACTIVE_WALLET must be the CURRENT holder of the rotating
 * party's key (default USER1).
 *
 * Env:
 *   PARTY=funder|beneficiary|verifier|arbiter|co:0   which slot (required)
 *   NEW_PARTY=ADMIN|addr_test1...                    replacement (required)
 *   ESCROW_V2_STATE_TOKEN=...                        overrides state.json
 *
 * Usage:
 *   ACTIVE_WALLET=ADMIN PARTY=verifier NEW_PARTY=USER1 pnpm run escrow-v2-rotate
 */

import { rotateParty, RotatePartyConfig } from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";
import { resolvePartyAddress, requireToken } from "./escrow-v2-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const partyRaw = process.env.PARTY;
  const newPartyRaw = process.env.NEW_PARTY;
  if (!partyRaw || !newPartyRaw)
    throw new Error(
      "PARTY and NEW_PARTY are required. Example:\n" +
        "  ACTIVE_WALLET=ADMIN PARTY=verifier NEW_PARTY=USER1 pnpm run escrow-v2-rotate",
    );

  const party: RotatePartyConfig["party"] = partyRaw.startsWith("co:")
    ? { coBeneficiary: Number(partyRaw.slice(3)) }
    : (partyRaw as "funder" | "beneficiary" | "verifier" | "arbiter");

  const stateTokenName = requireToken(
    "ESCROW_V2_STATE_TOKEN",
    loadState().escrowV2StateTokenName,
    "run escrow-v2-create first.",
  );

  console.log(`Rotating ${partyRaw} → ${newPartyRaw} (current key signs)...`);
  const tx = await rotateParty(lucid, {
    stateTokenName,
    party,
    newParty: resolvePartyAddress(newPartyRaw),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Party rotated.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
