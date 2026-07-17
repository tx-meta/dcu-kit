/**
 * Expire Proposal Example
 *
 * Permissionless cleanup: retires a terminal proposal (an Open one past its
 * deadline that never met quorum, or a stale decided one) and burns its Proposal
 * State NFT, reclaiming the min-ADA to the cranker.
 *
 * Usage:
 *   pnpm run governance-expire
 */

import { buildGovernance, expireProposal } from "@tx-meta/dcu-kit/governance";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";
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
  if (!state.governanceSeed || !state.governanceProposalId) {
    throw new Error("Run governance-init and governance-propose first.");
  }
  const instance = buildGovernance(state.governanceSeed);
  const scriptRefs = await govScriptRefs(lucid, state);

  const tx = await expireProposal(lucid, {
    instance,
    proposalId: state.governanceProposalId,
    scriptRefs,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  console.log("Proposal retired and its NFT burned.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
