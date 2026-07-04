/**
 * Inspect Escrow Example
 *
 * Read-only: prints the escrow's current state — milestone progress, locked
 * balance, and expiry. Costs nothing.
 *
 * Env:
 *   ESCROW_STATE_TOKEN=...  overrides the state.json value from escrow-create
 *
 * Usage:
 *   pnpm run inspect-escrow
 */

import { Effect } from "effect";
import { getEscrowStateProgram } from "@tx-meta/dcu-kit/escrow";
import { makeLucid, logError } from "./context.js";
import { loadState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  const stateTokenName =
    process.env.ESCROW_STATE_TOKEN ?? loadState().escrowStateTokenName;
  if (!stateTokenName)
    throw new Error(
      "No escrowStateTokenName in state.json (and ESCROW_STATE_TOKEN not set). Run escrow-create first.",
    );

  const escrow = await Effect.runPromise(
    getEscrowStateProgram(lucid, { stateTokenName }),
  );

  console.log("Escrow", stateTokenName.slice(0, 16) + "...");
  console.log(
    "  milestones: ",
    `${escrow.releasedCount}/${escrow.totalMilestones} released`,
  );
  console.log(
    "  next tranche:",
    escrow.nextTranche === null ? "none (complete)" : escrow.nextTranche,
  );
  console.log("  balance:    ", escrow.remainingBalance.toString());
  console.log(
    "  expiry:     ",
    new Date(Number(escrow.expiry)).toISOString(),
    escrow.expired ? "(EXPIRED — funder may reclaim)" : "",
  );
  console.log(
    "  utxo:       ",
    `${escrow.utxo.txHash.slice(0, 16)}...#${escrow.utxo.outputIndex}`,
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
