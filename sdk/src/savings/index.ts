// Savings module — primitive #7: persistent per-member capital accounts.
// Standalone subpath export ("@tx-meta/dcu-kit/savings"); imports core only.

export * from "./types.js";
export * from "./utils.js";
export * from "./validators.js";

export * from "./endpoints/createFund.js";
export * from "./endpoints/joinFund.js";
export * from "./endpoints/deposit.js";
export * from "./endpoints/withdrawSavings.js";
export * from "./endpoints/socialPayout.js";
export * from "./endpoints/updateFund.js";
export * from "./endpoints/closeCycle.js";
export * from "./endpoints/claimShareOut.js";
export * from "./endpoints/exitFund.js";
export * from "./endpoints/closeFund.js";
export * from "./endpoints/disburseLoan.js";
export * from "./endpoints/repayLoan.js";
export * from "./endpoints/markArrears.js";
export * from "./endpoints/writeOffLoan.js";

export * from "./queries/getFundState.js";
export * from "./queries/getFundMembers.js";
export * from "./queries/getFundLoans.js";
