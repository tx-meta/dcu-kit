/**
 * Shared governance-example helpers.
 *
 * The dispatcher (~7.5KB) and voting (~10KB) validators no longer fit inline
 * together within the 16,384-byte tx limit, so every voting-coupled example
 * resolves the reference-script UTxOs governance-init deployed.
 */

import type { LucidEvolution } from "@lucid-evolution/lucid";
import type { GovScriptRefs } from "@tx-meta/dcu-kit/governance";
import type { ExampleState } from "./state.js";

export async function govScriptRefs(
  lucid: LucidEvolution,
  state: ExampleState,
): Promise<GovScriptRefs> {
  if (
    !state.scriptRefGovernanceDispatcher ||
    !state.scriptRefGovernanceVoting
  ) {
    throw new Error(
      "No governance reference scripts in state — run governance-init first.",
    );
  }
  const [dispatcher, voting] = await lucid.utxosByOutRef([
    state.scriptRefGovernanceDispatcher,
    state.scriptRefGovernanceVoting,
  ]);
  if (!dispatcher?.scriptRef || !voting?.scriptRef) {
    throw new Error(
      "Governance reference-script UTxOs not found on-chain — re-run governance-init.",
    );
  }
  return { dispatcher, voting };
}
