/**
 * Cast Vote Example
 *
 * Casts one weighted vote: spends the proposal to advance its cached tally AND
 * the member's voter record to append this proposal to its voted list — the
 * double-vote nullifier. The member must have registered once
 * (governance-register) before their first vote.
 *
 * The voter spends their eligibility-token UTxO to prove membership at a
 * resolved index; the token returns to the wallet as change.
 *
 * Env:
 *   ACTIVE_WALLET=USER1|USER2|ADMIN  which member votes
 *   MEMBER_UNIT=<policy+name>        the voter's eligibility token unit
 *   APPROVE=true|false               vote for or against (default true)
 *
 * Usage:
 *   ACTIVE_WALLET=USER2 pnpm run governance-vote
 */

import { buildGovernance, castVote } from "@tx-meta/dcu-kit/governance";
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
  if (!state.governanceSeed) {
    throw new Error("No governanceSeed in state — run governance-init first.");
  }
  if (!state.governanceProposalId) {
    throw new Error(
      "No governanceProposalId in state — run governance-propose first.",
    );
  }
  const memberUnit = process.env.MEMBER_UNIT ?? state.governanceMemberUnit;
  if (!memberUnit) {
    throw new Error("MEMBER_UNIT is required — the voter's eligibility token.");
  }

  const instance = buildGovernance(state.governanceSeed);
  const scriptRefs = await govScriptRefs(lucid, state);
  const approve = (process.env.APPROVE ?? "true") === "true";

  console.log(
    `Voting ${approve ? "FOR" : "AGAINST"} proposal ${state.governanceProposalId}`,
  );
  const { tx, recordName } = await castVote(lucid, {
    instance,
    proposalId: state.governanceProposalId,
    approve,
    voterTokenUnit: memberUnit,
    scriptRefs,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  console.log("Vote recorded. Voter record:", recordName);
  console.log("Inspect the tally with governance-inspect.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
