// Back-compat shim: the multisig module moved to src/multisig/ (standalone,
// reusable outside the DCU endpoints). Import from "@tx-meta/dcu-kit/multisig"
// going forward; this path keeps existing imports working.
export * from "../../multisig/index.js";
