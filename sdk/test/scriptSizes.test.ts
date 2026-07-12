import { describe, it, expect } from "vitest";
import roscaBlueprint from "../src/core/plutus.json" with { type: "json" };
import escrowBlueprint from "../src/escrow/plutus.json" with { type: "json" };
import savingsBlueprint from "../src/savings/plutus.json" with { type: "json" };
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

  // The savings-credit validator sits at ~15.6KB — 97% of the ceiling. This
  // guard is what turns the next size regression into a loud test failure
  // instead of a blocked deploy; the known remedy is a withdraw-zero family
  // split (the treasury precedent).
  it("every savings validator is within the deployable-ref-script ceiling", () => {
    expect(oversized(savingsBlueprint as { validators: Validator[] })).toEqual(
      [],
    );
  });
});
