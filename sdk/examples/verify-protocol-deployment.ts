/**
 * Verify Protocol Deployment — the E1 identity chain, read-only.
 *
 * Runs `verifyProtocolDeployment` against the deployment recorded in
 * state.json: registry fingerprints → bundled blueprint → applied script
 * bytes → ledger hashes → settings NFT + datum → on-chain reference-script
 * CBOR for all six reference UTxOs, plus the four family stake registrations
 * (read-only provider query — nothing is signed or submitted).
 *
 * Usage:
 *   npx tsx verify-protocol-deployment.ts
 *
 * Evidence: examples/evidence/verify-protocol-deployment-<timestamp>.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Effect } from "effect";
import {
  verifyProtocolDeployment,
  VerifyProtocolDeploymentConfig,
} from "@tx-meta/dcu-kit";
import { makeLucid, logError } from "./context.js";
import { loadState } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log("Requires a live deployment (state.json). Run on Preprod.");
    process.exit(0);
  }

  const state = loadState();
  if (!state.settingsPolicy) throw new Error("No settingsPolicy in state.json");
  const refs = {
    treasury: state.scriptRefTreasury,
    group: state.scriptRefGroup,
    treasuryRounds: state.scriptRefTreasuryRounds,
    treasuryLifecycle: state.scriptRefTreasuryLifecycle,
    treasuryRecovery: state.scriptRefTreasuryRecovery,
    treasuryReserve: state.scriptRefTreasuryReserve,
  };
  for (const [key, ref] of Object.entries(refs))
    if (!ref) throw new Error(`No ${key} script ref in state.json`);

  const config: VerifyProtocolDeploymentConfig = {
    settingsPolicy: state.settingsPolicy,
    refs: refs as VerifyProtocolDeploymentConfig["refs"],
    expected: {
      settingsUnit: state.settingsPolicy + "73657474696e6773",
      network: process.env.NETWORK ?? "Preprod",
    },
  };

  console.log("Verifying the full deployment identity chain (read-only)...");
  const result = await Effect.runPromise(
    verifyProtocolDeployment(lucid, config),
  );

  for (const [key, ref] of Object.entries(result.refs)) {
    const mark = ref.scriptMatches && ref.hashMatches ? "✓" : "✗";
    console.log(
      `  ${mark} ${key}: ${ref.outRef.txHash.slice(0, 8)}…#${ref.outRef.outputIndex}` +
        ` hash ${ref.onChainScriptHash?.slice(0, 12) ?? "—"}…`,
    );
  }
  console.log(
    `  ${result.settings.found && result.settings.consistent ? "✓" : "✗"} settings ${result.settingsUnit.slice(0, 12)}… (datum ${result.settings.consistent ? "consistent" : "INCONSISTENT"})`,
  );
  for (const [family, reg] of Object.entries(result.stakeRegistrations))
    console.log(
      `  ${reg.status === "registered" ? "✓" : "✗"} stake ${family}: ${reg.status}`,
    );
  console.log(
    `  ${result.registry.fingerprintsMatch ? "✓" : "✗"} registry fingerprints (sdk ${result.registry.sdkVersion})`,
  );

  const evidenceDir = path.join(__dirname, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(
    evidenceDir,
    `verify-protocol-deployment-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  fs.writeFileSync(
    file,
    JSON.stringify(
      { ...result, capturedAt: new Date().toISOString() },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
  console.log(`\nEvidence: ${path.relative(process.cwd(), file)}`);

  if (!result.ok) {
    console.error("\nDEPLOYMENT VERIFICATION FAILED:");
    for (const issue of result.issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  console.log("\nDeployment verified — the full identity chain holds.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
