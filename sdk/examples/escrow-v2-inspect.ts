/**
 * Inspect Escrow V2 Example
 *
 * Read-only dashboard of one v2 escrow: schedule, funding, evidence, dispute
 * state, and which action window is currently open.
 *
 * Env:
 *   ESCROW_V2_STATE_TOKEN=...   overrides state.json (escrowV2StateTokenName)
 *
 * Usage:
 *   pnpm run escrow-v2-inspect
 */

import { Effect } from "effect";
import { getEscrowStateProgram } from "@tx-meta/dcu-kit/escrow/v2";
import { makeLucid, logError } from "./context.js";
import { loadState } from "./state.js";
import { requireToken, untilLabel } from "./escrow-v2-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  const stateTokenName = requireToken(
    "ESCROW_V2_STATE_TOKEN",
    loadState().escrowV2StateTokenName,
    "run escrow-v2-create first.",
  );

  const s = await Effect.runPromise(
    getEscrowStateProgram(lucid, { stateTokenName }),
  );

  console.log(`\n─ Escrow v2: ${s.title}`);
  console.log(`  state token : ${stateTokenName}`);
  console.log(`  funder      : ${s.funderAddress}`);
  console.log(`  beneficiary : ${s.beneficiaryAddress}`);
  console.log(
    `  mode        : ${s.fundingMode} / ${s.timeoutPolicy}` +
      (s.hasArbiter ? " / arbiter" : ""),
  );
  console.log(
    `  progress    : ${s.releasedCount}/${s.totalMilestones} released, ` +
      `${Number(s.lockedBalance) / 1e6} ADA locked, ` +
      `${Number(s.remainingTotal) / 1e6} ADA still scheduled`,
  );
  for (const [i, m] of s.milestones.entries())
    console.log(
      `  m${i}: ${Number(m.amount) / 1e6} ADA  ${
        m.released
          ? "RELEASED"
          : `deadline ${untilLabel(m.deadline)}${m.evidence ? "  evidence ✓" : ""}`
      }`,
    );
  if (s.releasedCount < s.totalMilestones) {
    console.log(
      `  next tranche: ${Number(s.nextTranche ?? 0n) / 1e6} ADA — ${
        s.nextTrancheFunded ? "funded" : "NOT funded (contribute first)"
      }`,
    );
    console.log(
      `  cure boundary ${untilLabel(s.cureBoundary)} — ${
        s.overdue ? "OVERDUE (timeout side open)" : "release window open"
      }`,
    );
  }
  if (s.disputeFrozenUntil)
    console.log(`  DISPUTE FREEZE until ${untilLabel(s.disputeFrozenUntil)}`);
  if (s.projectId) console.log(`  project     : ${s.projectId}`);
  if (s.contentHash) console.log(`  terms hash  : ${s.contentHash}`);
  console.log();
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
