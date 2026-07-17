import {
  applyDoubleCborEncoding,
  LucidEvolution,
  Script,
  validatorToAddress,
  validatorToRewardAddress,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import blueprint from "../core/plutus.json" with { type: "json" };
import {
  alwaysFailsValidator,
  buildProtocol,
  settingsTokenName,
  TreasuryFamily,
} from "../core/validators/constants.js";
import { validatorRegistry } from "../core/validators/registry.js";
import { DcuError, SetupError } from "../core/errors.js";
import { DeployedScriptKey, ScriptRefOutRef } from "./deployScripts.js";
import {
  unsignedVerifySettingsProgram,
  VerifySettingsResult,
} from "./verifySettings.js";

export type VerifyProtocolDeploymentConfig = {
  /** The deployment's settings policy — everything else derives from it. */
  settingsPolicy: string;
  /** The six reference-script out-refs, as recorded in the deployment manifest. */
  refs: Record<DeployedScriptKey, ScriptRefOutRef>;
  /**
   * Manifest fields to cross-check against the derived/queried values, so a
   * manifest that drifted from the settings policy or network is caught here.
   */
  expected?: {
    settingsUnit?: string;
    network?: string;
  };
};

export type RefVerification = {
  outRef: ScriptRefOutRef;
  found: boolean;
  atDeployAddress: boolean;
  /** Exact CBOR equality between the on-chain scriptRef and the locally applied script. */
  scriptMatches: boolean;
  /** Ledger hash of the script the chain actually holds (null when not found / no scriptRef). */
  onChainScriptHash: string | null;
  /** Hash of the locally derived (blueprint + applied params) script. */
  expectedScriptHash: string;
  hashMatches: boolean;
};

export type StakeRegistrationStatus =
  "registered" | "not-registered" | "unknown";

export type StakeRegistrationCheck = {
  rewardAddress: string;
  status: StakeRegistrationStatus;
};

export type RegistryVerification = {
  /** The sdk version the bundled registry declares its fingerprints for. */
  sdkVersion: string;
  /** True when every bundled rosca blueprint fingerprint matches the registry. */
  fingerprintsMatch: boolean;
  mismatches: string[];
};

export type VerifyProtocolDeploymentResult = {
  ok: boolean;
  /** Human-readable findings; empty when ok === true. */
  issues: string[];
  deployAddress: string;
  settingsUnit: string;
  refs: Record<DeployedScriptKey, RefVerification>;
  settings: VerifySettingsResult;
  settingsAtDeployAddress: boolean;
  stakeRegistrations: Record<TreasuryFamily, StakeRegistrationCheck>;
  registry: RegistryVerification;
};

const REF_KEYS: DeployedScriptKey[] = [
  "treasury",
  "group",
  "treasuryRounds",
  "treasuryLifecycle",
  "treasuryRecovery",
  "treasuryReserve",
];

const FAMILIES: TreasuryFamily[] = [
  "rounds",
  "lifecycle",
  "recovery",
  "reserve",
];

/** sha256 hex of a blueprint validator's compiledCode — the registry fingerprint scheme. */
const fingerprint = (compiledCode: string): string =>
  bytesToHex(sha256(utf8ToBytes(compiledCode)));

/**
 * Compare the bundled rosca blueprint against the bundled validator registry.
 * Both ship inside the SDK package, so this proves the artifact's internal
 * consistency: the fingerprints the registry declares are the bytes the SDK
 * actually derives its validators from.
 */
const verifyRegistryFingerprints = (): RegistryVerification => {
  const declared = validatorRegistry.families.rosca.validators;
  const mismatches: string[] = [];
  const seen = new Set<string>();
  for (const v of blueprint.validators ?? []) {
    if (!v.title || !v.compiledCode) continue;
    seen.add(v.title);
    const actual = fingerprint(v.compiledCode);
    if (!(v.title in declared)) {
      mismatches.push(`${v.title}: in blueprint but not in registry`);
    } else if (declared[v.title] !== actual) {
      mismatches.push(
        `${v.title}: registry ${declared[v.title].slice(0, 12)}… != blueprint ${actual.slice(0, 12)}…`,
      );
    }
  }
  for (const title of Object.keys(declared)) {
    if (!seen.has(title))
      mismatches.push(`${title}: in registry but not in blueprint`);
  }
  return {
    sdkVersion: validatorRegistry.sdkVersion,
    fingerprintsMatch: mismatches.length === 0,
    mismatches,
  };
};

/**
 * Read-only stake registration state for a reward address.
 *
 * `provider.getDelegation` cannot answer this — Blockfrost's implementation
 * returns the same `{ poolId: null, rewards: 0n }` for unregistered and
 * registered-with-no-rewards credentials — so the check goes one level down:
 * - Blockfrost: `GET /accounts/{rewardAddress}` and read `active`.
 * - Emulator: the tracked `chain[rewardAddress].registeredStake` flag.
 * - Any other provider: `unknown` (reported as an issue, never guessed).
 *
 * Registration MUTATION stays in `registerTreasuryStake` — verification never
 * submits anything.
 */
const stakeRegistrationStatus = (
  lucid: LucidEvolution,
  rewardAddress: string,
): Effect.Effect<StakeRegistrationStatus, never, never> => {
  const provider = lucid.config().provider as unknown as {
    // Blockfrost
    url?: string;
    projectId?: string;
    // Emulator
    ledger?: unknown;
    chain?: Record<string, { registeredStake?: boolean }>;
  };

  if (provider?.ledger !== undefined && provider?.chain !== undefined) {
    return Effect.succeed(
      provider.chain[rewardAddress]?.registeredStake === true
        ? "registered"
        : "not-registered",
    );
  }

  if (
    typeof provider?.url === "string" &&
    typeof provider?.projectId === "string"
  ) {
    return Effect.tryPromise({
      try: async (): Promise<StakeRegistrationStatus> => {
        const res = await fetch(`${provider.url}/accounts/${rewardAddress}`, {
          headers: { project_id: provider.projectId! },
        });
        if (res.status === 404) return "not-registered";
        if (!res.ok) return "unknown";
        const body = (await res.json()) as {
          active?: boolean;
          error?: string;
        };
        if (body.error) return "not-registered";
        return body.active === true ? "registered" : "not-registered";
      },
      catch: () => "unknown" as const,
    }).pipe(Effect.orElse(() => Effect.succeed("unknown" as const)));
  }

  return Effect.succeed("unknown");
};

/**
 * Verify a full protocol deployment end-to-end, read-only — the E1 identity
 * chain: registry fingerprint → bundled blueprint → applied script bytes →
 * ledger hash → settings datum → on-chain reference-script CBOR for all six
 * reference UTxOs, plus the four family stake registrations.
 *
 * Checks performed:
 * - Registry: bundled `validator-registry.json` fingerprints match the bundled
 *   rosca blueprint (sha256 of each validator's compiledCode).
 * - All six reference UTxOs exist at the given out-refs, sit at the always-fails
 *   deployment address, and hold the exact applied-script CBOR the SDK derives
 *   from `settingsPolicy`; on-chain script hashes match locally derived hashes.
 * - The settings NFT exists at the always-fails address and its ProtocolSettings
 *   datum matches the derived account/group/treasury policies and the four
 *   treasury family stake hashes (via `verifySettings`).
 * - The four family stake credentials are registered (read-only provider query;
 *   see `stakeRegistrationStatus`).
 * - The manifest's `settingsUnit` / `network` agree with the derived/connected
 *   values when `expected` is given.
 *
 * Nothing is signed or submitted; any wallet (or none) may be selected.
 * A failed check means `ok: false` with a descriptive `issues` array — the
 * Effect only fails on provider/query errors.
 *
 * `verifyDeployment` (treasury+group only) is retained for compatibility;
 * new deployment checks should use this op.
 */
export const verifyProtocolDeployment = (
  lucid: LucidEvolution,
  config: VerifyProtocolDeploymentConfig,
): Effect.Effect<VerifyProtocolDeploymentResult, DcuError, never> =>
  Effect.gen(function* () {
    const { settingsPolicy, refs, expected } = config;
    const issues: string[] = [];

    const network = lucid.config().network!;
    const protocol = buildProtocol(settingsPolicy);
    const settingsUnit = settingsPolicy + settingsTokenName;
    const deployAddress = validatorToAddress(
      network,
      alwaysFailsValidator.elseAlwaysFails,
    );

    // --- Manifest agreement -------------------------------------------------
    if (expected?.settingsUnit && expected.settingsUnit !== settingsUnit)
      issues.push(
        `manifest settingsUnit ${expected.settingsUnit} does not match the derived unit ${settingsUnit}`,
      );
    if (expected?.network && expected.network !== network)
      issues.push(
        `manifest network ${expected.network} does not match the connected network ${network}`,
      );

    // --- Registry fingerprints ---------------------------------------------
    const registry = verifyRegistryFingerprints();
    if (!registry.fingerprintsMatch)
      issues.push(
        `validator registry fingerprints disagree with the bundled blueprint: ${registry.mismatches.join("; ")}`,
      );

    // --- The six reference scripts ------------------------------------------
    const expectedScripts: Record<DeployedScriptKey, Script> = {
      treasury: protocol.treasuryValidator.mintTreasury,
      group: protocol.groupValidator.spendGroup,
      treasuryRounds: protocol.treasuryStakeValidators.rounds,
      treasuryLifecycle: protocol.treasuryStakeValidators.lifecycle,
      treasuryRecovery: protocol.treasuryStakeValidators.recovery,
      treasuryReserve: protocol.treasuryStakeValidators.reserve,
    };

    const utxos = yield* Effect.tryPromise({
      try: () =>
        lucid.utxosByOutRef(
          REF_KEYS.map((key) => ({
            txHash: refs[key].txHash,
            outputIndex: refs[key].outputIndex,
          })),
        ),
      catch: (e) =>
        new SetupError({
          message: `verifyProtocolDeployment: utxosByOutRef query failed: ${e}`,
        }),
    });

    const refResults = {} as Record<DeployedScriptKey, RefVerification>;
    for (const key of REF_KEYS) {
      const outRef = refs[key];
      const utxo = utxos.find(
        (u) =>
          u.txHash === outRef.txHash && u.outputIndex === outRef.outputIndex,
      );
      const expectedScript = expectedScripts[key];
      const expectedScriptHash = validatorToScriptHash(expectedScript);

      if (!utxo) {
        issues.push(
          `${key} ref UTxO not found: ${outRef.txHash}#${outRef.outputIndex}`,
        );
        refResults[key] = {
          outRef,
          found: false,
          atDeployAddress: false,
          scriptMatches: false,
          onChainScriptHash: null,
          expectedScriptHash,
          hashMatches: false,
        };
        continue;
      }

      const atDeployAddress = utxo.address === deployAddress;
      if (!atDeployAddress)
        issues.push(`${key} ref UTxO is at wrong address: ${utxo.address}`);

      let scriptMatches = false;
      let onChainScriptHash: string | null = null;
      if (!utxo.scriptRef) {
        issues.push(`${key} ref UTxO has no scriptRef`);
      } else {
        scriptMatches =
          applyDoubleCborEncoding(utxo.scriptRef.script) ===
          applyDoubleCborEncoding(expectedScript.script);
        onChainScriptHash = validatorToScriptHash(utxo.scriptRef);
        if (!scriptMatches)
          issues.push(
            `${key} scriptRef CBOR does not match the locally derived validator`,
          );
        if (onChainScriptHash !== expectedScriptHash)
          issues.push(
            `${key} on-chain script hash ${onChainScriptHash} != derived ${expectedScriptHash}`,
          );
      }

      refResults[key] = {
        outRef,
        found: true,
        atDeployAddress,
        scriptMatches,
        onChainScriptHash,
        expectedScriptHash,
        hashMatches: onChainScriptHash === expectedScriptHash,
      };
    }

    // --- Settings NFT + datum ------------------------------------------------
    const settings = yield* unsignedVerifySettingsProgram(
      lucid,
      settingsPolicy,
    );
    if (!settings.found)
      issues.push(`settings NFT ${settingsUnit} not found on-chain`);
    else if (settings.consistent !== true)
      issues.push(
        "settings datum policies do not match the validators derived from the settings policy",
      );
    const settingsAtDeployAddress = settings.utxoAddress === deployAddress;
    if (settings.found && !settingsAtDeployAddress)
      issues.push(
        `settings UTxO is at ${settings.utxoAddress}, expected the always-fails address ${deployAddress}`,
      );

    // --- Stake registrations (read-only) --------------------------------------
    const stakeRegistrations = {} as Record<
      TreasuryFamily,
      StakeRegistrationCheck
    >;
    for (const family of FAMILIES) {
      const rewardAddress = validatorToRewardAddress(
        network,
        protocol.treasuryStakeValidators[family],
      );
      const status = yield* stakeRegistrationStatus(lucid, rewardAddress);
      if (status === "not-registered")
        issues.push(`${family} stake credential is not registered`);
      if (status === "unknown")
        issues.push(
          `${family} stake registration state is not readable through this provider — verify with Blockfrost or the emulator`,
        );
      stakeRegistrations[family] = { rewardAddress, status };
    }

    return {
      ok: issues.length === 0,
      issues,
      deployAddress,
      settingsUnit,
      refs: refResults,
      settings,
      settingsAtDeployAddress,
      stakeRegistrations,
      registry,
    };
  });
