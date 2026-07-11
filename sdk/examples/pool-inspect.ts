/**
 * Inspect Pool Example
 *
 * Read-only view of a pool: charter, quorum, status, and the live deposits
 * ledger (the contributions cap-table the quorum allocates from).
 *
 * Env:
 *   POOL_TOKEN=...   overrides state.json
 *
 * Usage:
 *   pnpm run pool-inspect
 */

import { Effect } from "effect";
import {
  getPoolStateProgram,
  getPoolDepositsProgram,
} from "@tx-meta/dcu-kit/escrow/v2";
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

  const poolTokenName = requireToken(
    "POOL_TOKEN",
    loadState().poolTokenName,
    "run pool-create first.",
  );

  const [pool, deposits] = await Promise.all([
    Effect.runPromise(getPoolStateProgram(lucid, { poolTokenName })),
    Effect.runPromise(getPoolDepositsProgram(lucid, { poolTokenName })),
  ]);

  console.log(`\n─ Pool: ${pool.title}  [${pool.status}]`);
  console.log(`  token name  : ${poolTokenName}`);
  console.log(`  quorum      : ${pool.quorum.type} ${pool.quorum.hash}`);
  console.log(`  escrow target: ${pool.escrowTarget}`);
  if (pool.fundingDeadline)
    console.log(
      `  allocations : close ${untilLabel(pool.fundingDeadline)}`,
    );
  const total = deposits.reduce((s, d) => s + d.amount, 0n);
  console.log(
    `  deposits    : ${deposits.length} live, ${Number(total) / 1e6} ADA committed`,
  );
  for (const d of deposits)
    console.log(
      `    ${Number(d.amount) / 1e6} ADA  from ${d.contributorAddress.slice(0, 24)}…` +
        (d.lockedUntil ? `  locked ${untilLabel(d.lockedUntil)}` : "") +
        `  (${d.txHash.slice(0, 12)}…#${d.outputIndex})`,
    );
  console.log();
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
