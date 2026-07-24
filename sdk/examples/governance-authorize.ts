/**
 * Authorize Action Example (the composition seam)
 *
 * Consumes a decision at the gate: spends the decision UTxO — which is exactly
 * what satisfies a target vault's unchanged `quorum: Credential` (its Script path
 * requires a spent input at that credential) — and BURNS the decision token so it
 * cannot be replayed.
 *
 * The gate binds the decision to the target vault: the target input must carry a
 * token NAMED the decision's target_id. In production this script's transaction is
 * COMPOSED with the vault's own action (e.g. a savings SocialPayout): the vault
 * spend and this decision spend share one transaction, the gate proves governance
 * approved an action on that vault, and the vault validator independently proves
 * the action is well-formed.
 *
 * Env:
 *   TARGET_UNIT=<policy+name>  the governed vault's state-token unit; its UTxO is
 *                              the input the gate binds the decision to
 *
 * Usage:
 *   pnpm run governance-authorize
 */

import { buildGovernance, authorizeAction } from "@tx-meta/dcu-kit/governance";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const state = loadState();
  if (!state.governanceSeed || !state.governanceProposalId) {
    throw new Error(
      "Run governance-init / propose / finalize / execute first.",
    );
  }
  const targetUnit = process.env.TARGET_UNIT ?? state.governanceTargetUnit;
  if (!targetUnit) {
    throw new Error(
      "TARGET_UNIT is required — the governed vault's state-token unit (policy + name).",
    );
  }

  const instance = buildGovernance(state.governanceSeed);
  const targetUtxo = (await lucid.utxoByUnit(targetUnit)) ?? undefined;
  if (!targetUtxo) {
    throw new Error(
      `No UTxO found holding the target vault token ${targetUnit}`,
    );
  }

  console.log("Authorizing the approved action against the target vault...");
  const tx = await authorizeAction(lucid, {
    instance,
    proposalId: state.governanceProposalId,
    targetUtxo,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  console.log("Decision consumed and burned. It cannot be replayed.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
