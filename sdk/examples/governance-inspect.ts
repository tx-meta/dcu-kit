/**
 * Inspect Governance Example
 *
 * Read-only. Prints the instance's charter (published hashes, voting mode, quorum,
 * threshold, timelock, governed targets) and every live proposal with its tally,
 * turnout, and status.
 *
 * Usage:
 *   pnpm run governance-inspect
 */

import {
  buildGovernance,
  getGovernanceState,
  getProposals,
} from "@tx-meta/dcu-kit/governance";
import { makeLucid, logError, selectEnvWallet } from "./context.js";
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

  const state = loadState();
  if (!state.governanceSeed) {
    throw new Error("No governanceSeed in state — run governance-init first.");
  }
  const instance = buildGovernance(state.governanceSeed);

  const charter = await getGovernanceState(lucid, instance);
  console.log("=== Charter ===");
  console.log("  voting mode     :", charter.voting_mode);
  console.log("  default quorum  :", charter.default_quorum.toString());
  console.log(
    "  default threshold:",
    `${charter.default_threshold.toString()} bp`,
  );
  console.log("  timelock (ms)   :", charter.timelock.toString());
  console.log("  member policy   :", charter.member_policy);
  console.log(
    "  governed targets:",
    [...charter.governed_targets.entries()]
      .map(([policy, name]) => `${policy}:${name}`)
      .join(", "),
  );
  console.log("  voting stake    :", charter.voting_stake_hash);
  console.log("  gate (quorum)   :", charter.gate_hash);

  const proposals = await getProposals(lucid, instance);
  console.log(`\n=== Proposals (${proposals.length}) ===`);
  for (const p of proposals) {
    const cast = p.proposal.tally_yes + p.proposal.tally_no;
    console.log(`\n  ${p.proposalId}`);
    console.log("    status  :", p.proposal.status);
    console.log("    target  :", p.proposal.target_id);
    console.log(
      "    tally   :",
      `yes ${p.proposal.tally_yes} / no ${p.proposal.tally_no} (cast ${cast}, quorum ${p.proposal.quorum})`,
    );
    console.log("    voters  :", p.proposal.votes_cast.toString());
    console.log(
      "    deadline:",
      new Date(Number(p.proposal.deadline)).toISOString(),
    );
  }
  if (proposals.length === 0) {
    console.log("  (none — open one with governance-propose)");
  }
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
