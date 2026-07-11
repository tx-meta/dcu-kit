/**
 * Savings Inspect Example
 *
 * Read-only: prints the fund's charter, totals, phase, vault balance, and
 * every live member account.
 *
 * Usage:
 *   pnpm run savings-inspect
 */

import {
  getFundStateProgram,
  getFundMembersProgram,
} from "@tx-meta/dcu-kit/savings";
import { Effect } from "effect";
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

  const state = loadState();
  if (!state.savingsFundTokenName) {
    throw new Error("No savingsFundTokenName in state.json.");
  }

  const fund = await Effect.runPromise(
    getFundStateProgram(lucid, state.savingsFundTokenName),
  );
  console.log("Fund:", state.savingsFundTokenName);
  console.log("  phase:", fund.phase);
  console.log("  vault balance:", fund.vaultBalance.toString());
  console.log("  shares_total:", fund.fund.shares_total.toString());
  console.log("  savings_total:", fund.fund.savings_total.toString());
  console.log("  social_total:", fund.fund.social_total.toString());
  console.log("  share_value:", fund.fund.share_value.toString());
  console.log("  withdrawal_policy:", fund.fund.withdrawal_policy.toString());
  if (typeof fund.fund.status !== "string") {
    const s = fund.fund.status.SharingOut;
    console.log(
      `  share-out: pot=${s.pot} shares=${s.shares} remaining=${s.shares_remaining}`,
    );
  }

  const members = await Effect.runPromise(
    getFundMembersProgram(lucid, state.savingsFundTokenName),
  );
  console.log(`Members (${members.length}):`);
  for (const m of members) {
    console.log(
      `  ${m.memberTokenSuffix.slice(0, 12)}… units=${m.account.share_units} social_paid=${m.account.social_paid} consent=${m.account.consent}`,
    );
  }
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
