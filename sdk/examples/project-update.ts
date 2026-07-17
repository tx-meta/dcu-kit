/**
 * Update Project Example
 *
 * Owner-only edit of the project anchor (title / doc hash / status / owner
 * rotation) — plus the project dashboard read: every LIVE escrow citing this
 * project, with progress and locked balance (the cap-table view).
 *
 * Wallet selection: ACTIVE_WALLET must be the owner (default USER1).
 *
 * Env:
 *   TITLE="..."               new title
 *   STATUS=Active|Closed      new status
 *   PROJECT_TOKEN=...         overrides state.json
 *
 * Usage:
 *   STATUS=Closed pnpm run project-update
 */

import { Effect } from "effect";
import {
  updateProject,
  getProjectStateProgram,
  getProjectEscrowsProgram,
} from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";
import { requireToken } from "./escrow-v2-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const projectTokenName = requireToken(
    "PROJECT_TOKEN",
    loadState().projectTokenName,
    "run project-create first.",
  );

  // Dashboard read before the update: the project's live escrows.
  const escrows = await Effect.runPromise(
    getProjectEscrowsProgram(lucid, { projectId: projectTokenName }),
  );
  console.log(`\nLive escrows citing this project: ${escrows.length}`);
  for (const e of escrows)
    console.log(
      `  ${e.title}  ${e.releasedCount}/${e.totalMilestones} released, ` +
        `${Number(e.lockedBalance) / 1e6} ADA locked  (${e.stateTokenName.slice(0, 16)}…)`,
    );

  const title = process.env.TITLE;
  const status = process.env.STATUS as "Active" | "Closed" | undefined;
  if (!title && !status) {
    const s = await Effect.runPromise(
      getProjectStateProgram(lucid, { projectTokenName }),
    );
    console.log(
      `\nCurrent state: "${s.title}" — ${s.status}. Set TITLE or STATUS to change it.\n`,
    );
    return;
  }

  console.log(
    `\nUpdating project${title ? ` title="${title}"` : ""}${status ? ` status=${status}` : ""}...`,
  );
  const tx = await updateProject(lucid, {
    projectTokenName,
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Project updated. Escrows citing it are unaffected.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
