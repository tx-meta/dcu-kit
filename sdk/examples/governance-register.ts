/**
 * Register Voter Example
 *
 * Registers a member as a voter: appends them to the instance roster (the
 * ever-registered set) and mints their voter-record token into a fresh record
 * UTxO with an empty voted list. One registration per member, ever — the
 * roster is what makes the voter record a sound double-vote nullifier.
 *
 * Env:
 *   ACTIVE_WALLET=USER1|USER2|ADMIN  which member registers
 *   MEMBER_UNIT=<policy+name>        the member's eligibility token unit
 *
 * Usage:
 *   ACTIVE_WALLET=USER2 pnpm run governance-register
 */

import { buildGovernance, registerVoter } from "@tx-meta/dcu-kit/governance";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, saveState } from "./state.js";
import { govScriptRefs } from "./governance-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const state = loadState();
  if (!state.governanceSeed) {
    throw new Error("No governanceSeed in state — run governance-init first.");
  }
  const memberUnit = process.env.MEMBER_UNIT ?? state.governanceMemberUnit;
  if (!memberUnit) {
    throw new Error(
      "MEMBER_UNIT is required — the member's eligibility token.",
    );
  }

  const instance = buildGovernance(state.governanceSeed);
  const scriptRefs = await govScriptRefs(lucid, state);

  console.log(`Registering voter for member token ${memberUnit.slice(56)}`);
  const { tx, recordName } = await registerVoter(lucid, {
    instance,
    voterTokenUnit: memberUnit,
    scriptRefs,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  saveState({ governanceMemberUnit: memberUnit });
  console.log("Voter registered. Record token:", recordName);
  console.log("Cast votes with governance-vote.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
