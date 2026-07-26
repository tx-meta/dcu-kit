/**
 * Verify Protocol Deployment — the E1 identity chain, read-only.
 *
 * Runs `verifyProtocolDeployment` against the deployment recorded in
 * state.json: registry fingerprints → bundled blueprint → applied script
 * bytes → ledger hashes → settings NFT + datum → on-chain reference-script
 * CBOR for all six ROSCA reference UTxOs, plus the four family stake
 * registrations (read-only provider query — nothing is signed or submitted).
 *
 * It then also hash-checks the four module reference scripts that sit
 * outside that six-key bundle — savings, escrow v2, and the two governance
 * refs — against the SDK's locally derived validators. Those four are
 * deployed at the deployer's OWN address (recoverable), not the ROSCA
 * always-fails address, so only presence + on-chain script identity are
 * checked for them, not address. The two governance refs are additionally
 * seed-parameterised (`buildGovernance(state.governanceSeed)`); when no seed
 * is recorded, that is reported as an explicit issue rather than silently
 * skipped or crashed on.
 *
 * Note: this stays hand-rolled rather than delegating to the SDK's now-wider
 * `verifyProtocolDeployment(config)` (which also covers all ten keys, see
 * `sdk/src/admin/verifyProtocolDeployment.ts`) because this example package
 * depends on a packed tarball snapshot of the SDK
 * (`file:../dcu-kit-*.tgz`, not a live workspace link) — delegating would
 * only pick up the widened config/behavior after a full SDK rebuild +
 * repack + reinstall here, which is out of scope for this change.
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
  applyDoubleCborEncoding,
  Script,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import {
  verifyProtocolDeployment,
  VerifyProtocolDeploymentConfig,
  VerifyProtocolDeploymentResult,
} from "@tx-meta/dcu-kit";
import { savingsVaultValidator } from "@tx-meta/dcu-kit/savings";
import { escrowV2Validator } from "@tx-meta/dcu-kit/escrow/v2";
import { buildGovernance } from "@tx-meta/dcu-kit/governance";
import { makeLucid, logError } from "./context.js";
import { loadState, ScriptRefOutRef } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The four module reference scripts outside the six-key ROSCA bundle that
 *  `verifyProtocolDeployment` already covers. */
const MODULE_KEYS = [
  "savings",
  "escrowV2",
  "governanceDispatcher",
  "governanceVoting",
] as const;
type ModuleKey = (typeof MODULE_KEYS)[number];

type ModuleRefRow = {
  outRef: ScriptRefOutRef;
  onChainScriptHash: string | null;
  ok: boolean;
};

/**
 * Hash-checks one module reference-script UTxO against a locally derived
 * expected script. `expectedScript` is null only for the seed-parameterised
 * governance refs when no `governanceSeed` is recorded — that case pushes its
 * own explicit issue rather than silently passing or crashing.
 */
async function verifyModuleRef(
  lucid: Awaited<ReturnType<typeof makeLucid>>["lucid"],
  key: ModuleKey,
  outRef: ScriptRefOutRef,
  expectedScript: Script | null,
  issues: string[],
): Promise<ModuleRefRow> {
  if (!expectedScript) {
    issues.push(
      `${key}: no governanceSeed in state.json — cannot derive the expected script to hash-check against`,
    );
    return { outRef, onChainScriptHash: null, ok: false };
  }

  const expectedScriptHash = validatorToScriptHash(expectedScript);
  const [utxo] = await lucid.utxosByOutRef([outRef]);
  if (!utxo) {
    issues.push(
      `${key} ref UTxO not found: ${outRef.txHash}#${outRef.outputIndex}`,
    );
    return { outRef, onChainScriptHash: null, ok: false };
  }
  if (!utxo.scriptRef) {
    issues.push(`${key} ref UTxO has no scriptRef`);
    return { outRef, onChainScriptHash: null, ok: false };
  }

  const onChainScriptHash = validatorToScriptHash(utxo.scriptRef);
  const cborMatches =
    applyDoubleCborEncoding(utxo.scriptRef.script) ===
    applyDoubleCborEncoding(expectedScript.script);
  if (!cborMatches)
    issues.push(
      `${key} scriptRef CBOR does not match the locally derived validator`,
    );
  if (onChainScriptHash !== expectedScriptHash)
    issues.push(
      `${key} on-chain script hash ${onChainScriptHash} != derived ${expectedScriptHash}`,
    );

  return {
    outRef,
    onChainScriptHash,
    ok: cborMatches && onChainScriptHash === expectedScriptHash,
  };
}

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
    savings: state.scriptRefSavings,
    escrowV2: state.scriptRefEscrowV2,
    governanceDispatcher: state.scriptRefGovernanceDispatcher,
    governanceVoting: state.scriptRefGovernanceVoting,
  };

  const ROSCA_KEYS = [
    "treasury",
    "group",
    "treasuryRounds",
    "treasuryLifecycle",
    "treasuryRecovery",
    "treasuryReserve",
  ] as const;

  const issues: string[] = [];
  for (const [name, outRef] of Object.entries(refs)) {
    if (!outRef) {
      issues.push(`${name}: not recorded in state.json`);
      continue;
    }
  }

  console.log("Verifying the full deployment identity chain (read-only)...");

  // --- Six ROSCA reference scripts + settings + stakes + registry --------
  // The SDK's typed config requires all six out-refs; if the bundle is
  // incomplete we cannot safely call it, so we skip that section (the
  // missing-ref issues above already make this non-`ok`) instead of crashing
  // on an undefined out-ref.
  const roscaRefsComplete = ROSCA_KEYS.every((key) => refs[key]);
  let result: VerifyProtocolDeploymentResult | null = null;

  if (roscaRefsComplete) {
    const config: VerifyProtocolDeploymentConfig = {
      settingsPolicy: state.settingsPolicy,
      refs: {
        treasury: refs.treasury!,
        group: refs.group!,
        treasuryRounds: refs.treasuryRounds!,
        treasuryLifecycle: refs.treasuryLifecycle!,
        treasuryRecovery: refs.treasuryRecovery!,
        treasuryReserve: refs.treasuryReserve!,
      },
      expected: {
        settingsUnit: state.settingsPolicy + "73657474696e6773",
        network: process.env.NETWORK ?? "Preprod",
      },
    };

    result = await Effect.runPromise(verifyProtocolDeployment(lucid, config));
    issues.push(...result.issues);

    for (const [key, ref] of Object.entries(result.refs)) {
      const mark = ref.scriptMatches && ref.hashMatches ? "✓" : "✗";
      console.log(
        `  ${mark} ${key}: ${ref.outRef.txHash.slice(0, 8)}…#${ref.outRef.outputIndex}` +
          ` hash ${ref.onChainScriptHash?.slice(0, 12) ?? "—"}…`,
      );
    }
  } else {
    console.log(
      "  ✗ ROSCA ref bundle incomplete — skipping the six-ref/settings/stake check (see issues below)",
    );
  }

  // --- Four module reference scripts (savings/escrowV2/governance) -------
  const governanceInstance = state.governanceSeed
    ? buildGovernance(state.governanceSeed)
    : null;

  const moduleExpected: Record<ModuleKey, Script | null> = {
    savings: savingsVaultValidator.spendVault,
    escrowV2: escrowV2Validator.spendEscrow,
    governanceDispatcher: governanceInstance?.dispatcherValidator.spend ?? null,
    governanceVoting: governanceInstance?.votingValidator ?? null,
  };

  for (const key of MODULE_KEYS) {
    const outRef = refs[key];
    if (!outRef) continue; // already recorded as an issue above
    const row = await verifyModuleRef(
      lucid,
      key,
      outRef,
      moduleExpected[key],
      issues,
    );
    console.log(
      `  ${row.ok ? "✓" : "✗"} ${key}: ${row.outRef.txHash.slice(0, 8)}…#${row.outRef.outputIndex}` +
        ` hash ${row.onChainScriptHash?.slice(0, 12) ?? "—"}…`,
    );
  }

  if (result) {
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
  }

  const ok = issues.length === 0;

  const evidenceDir = path.join(__dirname, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(
    evidenceDir,
    `verify-protocol-deployment-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  fs.writeFileSync(
    file,
    JSON.stringify(
      { ok, issues, rosca: result, capturedAt: new Date().toISOString() },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
  console.log(`\nEvidence: ${path.relative(process.cwd(), file)}`);

  if (!ok) {
    console.error("\nDEPLOYMENT VERIFICATION FAILED:");
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  console.log("\nDeployment verified — the full identity chain holds.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
