/**
 * Inspect Reserve Example
 *
 * Read-only: prints the group's mutual reserve state — pot balance, pending
 * stand-in cover, and the configured levies. Costs nothing.
 *
 * Usage:
 *   pnpm run inspect-reserve
 */

import { Effect } from "effect";
import { getReserveStateProgram } from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
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

  const sdk = loadSdk();
  const state = loadState();
  const groupTokenSuffix =
    process.env.GROUP_TOKEN_SUFFIX ?? state.groupTokenSuffix;
  if (!groupTokenSuffix)
    throw new Error(
      "No groupTokenSuffix in state.json (and GROUP_TOKEN_SUFFIX not set). Run create-group first.",
    );

  const reserve = await Effect.runPromise(
    getReserveStateProgram(sdk.protocol, lucid, groupTokenSuffix),
  );

  console.log("Mutual reserve");
  console.log("  balance:         ", reserve.balance.toString());
  console.log("  stand-in rounds: ", reserve.standinRounds.toString());
  console.log("  join levy:       ", reserve.joinLevy.toString());
  console.log("  round levy:      ", reserve.roundLevy.toString());
  if (reserve.standinRounds > 0n)
    console.log(
      "  NOTE: pending cover — each distribute round draws min(fee, pot) until this reaches 0.",
    );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
