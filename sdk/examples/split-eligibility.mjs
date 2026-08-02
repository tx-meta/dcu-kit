/**
 * Re-separate the governance eligibility and target tokens.
 *
 * governance-mint-tokens mints them into separate outputs because the on-chain
 * member_id_of derivation requires the eligibility input to hold exactly ONE
 * token name under the member policy. Ordinary change handling in later
 * transactions merges them back into one UTxO, which makes registerVoter fail
 * with "Withdraw[0] the validator crashed". This splits them apart again.
 */
import { makeLucid, cexplorerTxUrl, selectEnvWallet } from "./dist/context.js";
import { loadState } from "./dist/state.js";

const state = loadState();
const { lucid } = await makeLucid();
await selectEnvWallet(lucid, "USER1");
const address = await lucid.wallet().address();

const memberUnit = state.governanceMemberUnit;
const targetUnit = state.governanceTargetUnit;

const tx = await lucid
  .newTx()
  // exactly one token name under the member policy in each output
  .pay.ToAddress(address, { [memberUnit]: 1n })
  .pay.ToAddress(address, { [targetUnit]: 1n })
  .complete();

const signed = await tx.sign.withWallet().complete();
const txHash = await signed.submit();
console.log("Split submitted. Hash:", txHash);
console.log("View:", cexplorerTxUrl(txHash));
await lucid.awaitTx(txHash);
console.log("Eligibility and target tokens now sit in separate UTxOs.");
