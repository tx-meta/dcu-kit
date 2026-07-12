// Governance module — primitive #9: propose → vote → decide.
// Standalone subpath export ("@tx-meta/dcu-kit/governance"); imports core only.

export * from "./types.js";
export * from "./validators.js";
export * from "./utils.js";

export * from "./endpoints/initGovernance.js";
export * from "./endpoints/registerVotingStake.js";
export * from "./endpoints/openProposal.js";
export * from "./endpoints/castVote.js";
// endpoints below are wired incrementally (finalize, execute, authorize,
// expire, updateCharter) + queries.
