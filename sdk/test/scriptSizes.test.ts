import { describe, it, expect } from "vitest";
import roscaBlueprint from "../src/core/plutus.json" with { type: "json" };
import escrowBlueprint from "../src/escrow/plutus.json" with { type: "json" };
import savingsBlueprint from "../src/savings/plutus.json" with { type: "json" };
import governanceBlueprint from "../src/governance/plutus.json" with { type: "json" };
import { MAX_REF_SCRIPT_BYTES } from "../src/admin/deployScripts.js";

// Permanent tripwire for the class of bug that blocked R4: a compiled validator
// that exceeds the deployable-reference-script ceiling can NEVER go on-chain (a
// reference-script deploy tx must carry the full script, bounded by maxTxSize).
// The Lucid emulator injects reference-script UTxOs directly into the ledger, so
// it cannot catch a deploy-size regression — this static check is the guard.
//
// The treasury split (spec 2026-07-04) brought the treasury family back under the
// line; this test fails loudly if any future change pushes a validator back over.

type Validator = { title: string; compiledCode: string };

const oversized = (blueprint: { validators: Validator[] }) => {
  const seen = new Set<string>();
  const over: Array<{ title: string; bytes: number }> = [];
  for (const v of blueprint.validators) {
    if (seen.has(v.title)) continue;
    seen.add(v.title);
    const bytes = v.compiledCode.length / 2;
    if (bytes > MAX_REF_SCRIPT_BYTES) over.push({ title: v.title, bytes });
  }
  return over;
};

describe("compiled validator sizes", () => {
  it("every rosca validator is within the deployable-ref-script ceiling", () => {
    expect(oversized(roscaBlueprint as { validators: Validator[] })).toEqual(
      [],
    );
  });

  it("every escrow validator is within the deployable-ref-script ceiling", () => {
    expect(oversized(escrowBlueprint as { validators: Validator[] })).toEqual(
      [],
    );
  });

  // ADR-0003 split the savings vault at 16,105 bytes (99.86% of the ceiling)
  // into a thin dispatcher plus two withdraw-zero families. This guard turns
  // the next size regression into a loud test failure instead of a blocked
  // deploy.
  it("every savings validator is within the deployable-ref-script ceiling", () => {
    expect(oversized(savingsBlueprint as { validators: Validator[] })).toEqual(
      [],
    );
  });

  // Governance was split withdraw-zero from line one (settings / thin dispatcher
  // / voting stake validator / gate), which is why every script is a few KB
  // rather than approaching the ceiling. This guard keeps it that way.
  it("every governance validator is within the deployable-ref-script ceiling", () => {
    expect(
      oversized(governanceBlueprint as { validators: Validator[] }),
    ).toEqual([]);
  });
});

// ADR-0003's second size gate. The hard ceiling above only fires once a
// validator is already undeployable — by then the remedy (another family split)
// changes every hash and needs its own rehearsal, which is exactly the corner
// savings was in at 16,105 bytes. The warning threshold fires while there is
// still room to act: crossing it is the signal to split again, NOT to spend the
// remaining headroom.
describe("compiled validator warning threshold", () => {
  const WARN_RATIO = 0.8;
  const WARN_BYTES = Math.floor(MAX_REF_SCRIPT_BYTES * WARN_RATIO);

  const overWarning = (blueprint: { validators: Validator[] }) => {
    const seen = new Set<string>();
    const over: Array<{ title: string; bytes: number; pct: string }> = [];
    for (const v of blueprint.validators) {
      if (seen.has(v.title)) continue;
      seen.add(v.title);
      const bytes = v.compiledCode.length / 2;
      if (bytes > WARN_BYTES)
        over.push({
          title: v.title,
          bytes,
          pct: `${((100 * bytes) / MAX_REF_SCRIPT_BYTES).toFixed(1)}%`,
        });
    }
    return over;
  };

  it("the warning threshold is 80% of the deployable ceiling", () => {
    expect(WARN_BYTES).toBe(12902);
  });

  it("every savings validator is under the 80% warning threshold", () => {
    expect(
      overWarning(savingsBlueprint as { validators: Validator[] }),
    ).toEqual([]);
  });

  it("every governance validator is under the 80% warning threshold", () => {
    expect(
      overWarning(governanceBlueprint as { validators: Validator[] }),
    ).toEqual([]);
  });
});
