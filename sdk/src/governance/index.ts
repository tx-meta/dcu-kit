// Governance module — primitive #9: propose → vote → decide.
// Standalone subpath export ("@tx-meta/dcu-kit/governance"); imports core only.

export * from "./types.js";
export * from "./validators.js";
export * from "./utils.js";

export * from "./endpoints/initGovernance.js";
export * from "./endpoints/registerVotingStake.js";
export * from "./endpoints/openProposal.js";
export * from "./endpoints/castVote.js";
export * from "./endpoints/finalizeProposal.js";
export * from "./endpoints/executeDecision.js";
export * from "./endpoints/authorizeAction.js";
export * from "./endpoints/expireProposal.js";
export * from "./endpoints/updateCharter.js";

export * from "./queries/getGovernanceState.js";
export * from "./queries/getProposals.js";
