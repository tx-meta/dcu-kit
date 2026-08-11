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
import type { ModuleScriptKey } from "./deployModuleScripts.js";
import {
  unsignedVerifySettingsProgram,
  VerifySettingsResult,
} from "./verifySettings.js";
import type { GovernanceInstance } from "../governance/validators.js";

/**
 * The standalone-module reference scripts that ship alongside a full
 * deployment but are NOT part of what `deployScripts()` deploys — they are
 * published by `deployModuleScripts()`, at the same always-fails address.
 * Kept separate from `DeployedScriptKey` (which must stay exactly the six
 * refs `deployScripts()` returns) — verification covers a strictly wider
 * set than any single deploy call does.
 */
export type { ModuleScriptKey };

/** Every reference script this verifier can check: the six ROSCA refs plus the eight standalone-module refs. */
export type VerifiableScriptKey = DeployedScriptKey | ModuleScriptKey;

export type VerifyProtocolDeploymentConfig = {
  /** The deployment's settings policy — the six ROSCA refs derive from it. */
  settingsPolicy: string;
  /**
   * Reference-script out-refs to verify. The six ROSCA refs are mandatory
   * (as before); the module refs are opt-in — omit a key entirely to
   * skip checking it, or include it (even as `undefined`) to have its
   * absence reported as an issue rather than silently ignored.
   */
  refs: Record<DeployedScriptKey, ScriptRefOutRef> &
    Partial<Record<ModuleScriptKey, ScriptRefOutRef>>;
  /**
   * Manifest fields to cross-check against the derived/queried values, so a
   * manifest that drifted from the settings policy or network is caught here.
   */
  expected?: {
    settingsUnit?: string;
    network?: string;
  };
  /**
   * The governance instance's seed out-ref. `governanceDispatcher` and
   * `governanceVoting` are parameterised by `buildGovernance(seed)` — their
   * expected script cannot be derived from `settingsPolicy` alone. When one
   * of those two keys is present in `refs` but no seed is given here, that
   * ref is reported as an explicit issue (never silently skipped, never a
   * crash).
   */
  governanceSeed?: { txHash: string; outputIndex: number };
};

export type RefVerification = {
  /**
   * False when the caller never mentioned this key in `config.refs` at all —
   * i.e. it was out of scope for this call. `found`/`hashMatches` are always
   * `false` on an unrequested row, so callers scanning `Object.values(refs)`
   * for failures must check `requested` first to avoid mistaking "not asked
   * about" for "asked about and failed".
   */
  requested: boolean;
  /** Null when the ref was never provided (key omitted, or present with no value). */
  outRef: ScriptRefOutRef | null;
  found: boolean;
  atDeployAddress: boolean;
  /** Exact CBOR equality between the on-chain scriptRef and the locally applied script. */
  scriptMatches: boolean;
  /** Ledger hash of the script the chain actually holds (null when not found / no scriptRef). */
  onChainScriptHash: string | null;
  /** Hash of the locally derived (blueprint + applied params) script; null when it could not be derived (governance ref with no seed). */
  expectedScriptHash: string | null;
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
  refs: Record<VerifiableScriptKey, RefVerification>;
  settings: VerifySettingsResult;
  settingsAtDeployAddress: boolean;
  stakeRegistrations: Record<TreasuryFamily, StakeRegistrationCheck>;
  /**
   * The governance instance's voting stake credential, when a `governanceSeed`
   * was supplied. Null when no seed was given (nothing to derive it from).
   */
  governanceVotingStake: StakeRegistrationCheck | null;
  /**
   * The two savings family stake credentials, checked whenever any savings
   * reference key is requested. Null when savings is out of scope for the call.
   */
  savingsStakeRegistrations: Record<
    SavingsFamilyName,
    StakeRegistrationCheck
  > | null;
  registry: RegistryVerification;
};

const ROSCA_KEYS: DeployedScriptKey[] = [
  "treasury",
  "group",
  "treasuryRounds",
  "treasuryLifecycle",
  "treasuryRecovery",
  "treasuryReserve",
];

const MODULE_KEYS: ModuleScriptKey[] = [
  "savings",
  "savingsGoverned",
  "savingsDirect",
  "escrowV2",
  "pool",
  "project",
  "governanceDispatcher",
  "governanceVoting",
];

const ALL_KEYS: VerifiableScriptKey[] = [...ROSCA_KEYS, ...MODULE_KEYS];

const FAMILIES: TreasuryFamily[] = [
  "rounds",
  "lifecycle",
  "recovery",
  "reserve",
];

/** The savings withdraw-zero families (ADR-0003). */
export type SavingsFamilyName = "governed" | "direct";

const SAVINGS_FAMILIES: SavingsFamilyName[] = ["governed", "direct"];

/**
 * The savings module's three reference scripts. They are verified as a unit:
 * a savings transaction reads the dispatcher AND its family, so a deployment
 * carrying only some of them is not a working savings deployment, and
 * reporting it as sound would be worse than not checking at all.
 */
const SAVINGS_KEYS: ModuleScriptKey[] = [
  "savings",
  "savingsGoverned",
  "savingsDirect",
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
          registered?: boolean;
          active?: boolean;
          error?: string;
        };
        if (body.error) return "not-registered";
        // `registered` is the registration state. `active` stays false until
        // the credential is delegated/epoch-activated, so it cannot answer
        // this question — a freshly registered credential reports
        // { registered: true, active: false }. Older API versions lack
        // `registered`; fall back to `active` there.
        if (typeof body.registered === "boolean")
          return body.registered ? "registered" : "not-registered";
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
 * ROSCA reference UTxOs (plus the four family stake registrations), and the
 * standalone-module reference scripts (the savings dispatcher and its two
 * withdraw-zero families, escrow v2, and the two seed-parameterised governance
 * refs) that ship alongside a deployment.
 *
 * Checks performed:
 * - Registry: bundled `validator-registry.json` fingerprints match the bundled
 *   rosca blueprint (sha256 of each validator's compiledCode).
 * - Every ref present in `config.refs` (the six ROSCA refs are mandatory; the
 *   module refs are opt-in) exists at its out-ref and holds the exact
 *   applied-script CBOR the SDK derives locally; on-chain script hashes match.
 *   Every one is checked against the always-fails deployment address: a ref at
 *   any other address is spendable, and spending one takes the deployment down
 *   for every consumer.
 * - `governanceDispatcher` / `governanceVoting` are parameterised by
 *   `buildGovernance(config.governanceSeed)`; if that key is present in
 *   `refs` but no seed is given, it's reported as an explicit issue rather
 *   than silently skipped or crashed on.
 * - A ref key entirely absent from `config.refs` is not checked at all (it's
 *   out of scope for this call); a key that IS present with no value is an
 *   explicit issue.
 * - The settings NFT exists at the always-fails address and its ProtocolSettings
 *   datum matches the derived account/group/treasury policies and the four
 *   treasury family stake hashes (via `verifySettings`).
 * - The four treasury family stake credentials are registered, and both savings
 *   family credentials whenever savings is in scope (read-only provider query;
 *   see `stakeRegistrationStatus`).
 * - Savings is verified as a unit: naming any of `savings`, `savingsGoverned`
 *   or `savingsDirect` requires all three, because a savings transaction reads
 *   the dispatcher and its family together.
 * - When a `governanceSeed` is given, the instance's voting stake credential is
 *   registered. Without it the instance is inert: every governance endpoint
 *   withdraws 0 ADA from the voting validator, which the ledger rejects for an
 *   unregistered account.
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
    const { settingsPolicy, refs, expected, governanceSeed } = config;
    const issues: string[] = [];
    // Untyped, permissive view of `refs` for internal use — the public config
    // type intentionally mandates the six ROSCA keys and leaves the four
    // module keys optional; this cast lets one loop over `ALL_KEYS` handle
    // both uniformly without fighting the intersection type at every index.
    const allRefs = refs as Partial<
      Record<VerifiableScriptKey, ScriptRefOutRef>
    >;

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

    // A key participates in this call only if the caller mentioned it at all
    // (`in`, not truthiness) — an omitted module key is out of scope and
    // silently skipped; a key that IS present with no value is an issue.
    const requestedKeys = ALL_KEYS.filter((key) => key in allRefs);

    // Savings is all-or-nothing: mentioning any of the three brings the other
    // two into scope, so a caller cannot verify the dispatcher alone and read
    // ok: true while every savings transaction would fail for want of a family
    // reference.
    const savingsRequested = SAVINGS_KEYS.some((key) =>
      requestedKeys.includes(key),
    );
    const missingSavingsKeys = savingsRequested
      ? SAVINGS_KEYS.filter((key) => !requestedKeys.includes(key))
      : [];
    for (const key of missingSavingsKeys)
      issues.push(
        `${key}: not provided — the savings module needs all three references (savings, savingsGoverned, savingsDirect); a transaction reads the dispatcher and its family together`,
      );

    // --- Reference scripts: six ROSCA (mandatory) + eight modules (opt-in) --
    // The savings/escrowV2/governance modules each embed their own full
    // compiled Aiken blueprint and are otherwise unreachable from the root
    // package entry. Importing them statically here would drag all three
    // into every consumer's bundle (measured +~360kb minified) even for
    // callers who never check those keys — so load each one lazily, only
    // when its key was actually requested for this call.
    const savingsModule =
      requestedKeys.includes("savings") ||
      requestedKeys.includes("savingsGoverned") ||
      requestedKeys.includes("savingsDirect")
        ? yield* Effect.tryPromise({
            try: () => import("../savings/validators.js"),
            catch: (e) =>
              new SetupError({
                message: `verifyProtocolDeployment: failed to load the savings module: ${e}`,
              }),
          })
        : null;
    const savingsVaultValidator = savingsModule?.savingsVaultValidator ?? null;

    // escrowV2, pool and project all live in the same module, so one lazy
    // import covers whichever of the three keys were requested.
    const escrowV2Module =
      requestedKeys.includes("escrowV2") ||
      requestedKeys.includes("pool") ||
      requestedKeys.includes("project")
        ? yield* Effect.tryPromise({
            try: () => import("../escrow/v2/validators.js"),
            catch: (e) =>
              new SetupError({
                message: `verifyProtocolDeployment: failed to load the escrow v2 module: ${e}`,
              }),
          })
        : null;
    const escrowV2Validator = escrowV2Module?.escrowV2Validator ?? null;
    const poolVaultValidator = escrowV2Module?.poolVaultValidator ?? null;
    const projectValidator = escrowV2Module?.projectValidator ?? null;

    // Governance's dispatcher/voting scripts are parameterised by the seed —
    // derive the instance once, up front, if a seed was given AND actually
    // requested (loading `buildGovernance` also lazily, for the same reason).
    const needsGovernance =
      requestedKeys.includes("governanceDispatcher") ||
      requestedKeys.includes("governanceVoting");
    const governanceInstance: GovernanceInstance | null =
      needsGovernance && governanceSeed
        ? (yield* Effect.tryPromise({
            try: () => import("../governance/validators.js"),
            catch: (e) =>
              new SetupError({
                message: `verifyProtocolDeployment: failed to load the governance module: ${e}`,
              }),
          })).buildGovernance(governanceSeed)
        : null;

    const expectedScriptFor = (key: VerifiableScriptKey): Script | null => {
      switch (key) {
        case "treasury":
          return protocol.treasuryValidator.mintTreasury;
        case "group":
          return protocol.groupValidator.spendGroup;
        case "treasuryRounds":
          return protocol.treasuryStakeValidators.rounds;
        case "treasuryLifecycle":
          return protocol.treasuryStakeValidators.lifecycle;
        case "treasuryRecovery":
          return protocol.treasuryStakeValidators.recovery;
        case "treasuryReserve":
          return protocol.treasuryStakeValidators.reserve;
        case "savings":
          return savingsVaultValidator?.spendVault ?? null;
        case "savingsGoverned":
          return savingsModule?.savingsGovernedValidator ?? null;
        case "savingsDirect":
          return savingsModule?.savingsDirectValidator ?? null;
        case "escrowV2":
          return escrowV2Validator?.spendEscrow ?? null;
        case "pool":
          return poolVaultValidator?.spendPool ?? null;
        case "project":
          return projectValidator?.spendProject ?? null;
        case "governanceDispatcher":
          return governanceInstance?.dispatcherValidator.spend ?? null;
        case "governanceVoting":
          return governanceInstance?.votingValidator ?? null;
      }
    };

    for (const key of requestedKeys) {
      if (!allRefs[key]) {
        issues.push(`${key}: ref not provided`);
        continue;
      }
      if (
        (key === "governanceDispatcher" || key === "governanceVoting") &&
        !governanceInstance
      ) {
        issues.push(
          `${key}: no governanceSeed provided — cannot derive the expected script to hash-check against`,
        );
      }
    }

    const queryableKeys = requestedKeys.filter((key) => allRefs[key]);
    const utxos = yield* Effect.tryPromise({
      try: () =>
        lucid.utxosByOutRef(
          queryableKeys.map((key) => ({
            txHash: allRefs[key]!.txHash,
            outputIndex: allRefs[key]!.outputIndex,
          })),
        ),
      catch: (e) =>
        new SetupError({
          message: `verifyProtocolDeployment: utxosByOutRef query failed: ${e}`,
        }),
    });

    const refResults = {} as Record<VerifiableScriptKey, RefVerification>;
    for (const key of ALL_KEYS) {
      const requested = requestedKeys.includes(key);
      const outRef = allRefs[key] ?? null;
      if (!outRef) {
        // Either never requested (out of scope for this call) or requested
        // with no value (issue already pushed above) — either way, nothing
        // more to check.
        refResults[key] = {
          requested,
          outRef: null,
          found: false,
          atDeployAddress: false,
          scriptMatches: false,
          onChainScriptHash: null,
          expectedScriptHash: null,
          hashMatches: false,
        };
        continue;
      }

      const expectedScript = expectedScriptFor(key);
      const expectedScriptHash = expectedScript
        ? validatorToScriptHash(expectedScript)
        : null;

      const utxo = utxos.find(
        (u) =>
          u.txHash === outRef.txHash && u.outputIndex === outRef.outputIndex,
      );

      if (!utxo) {
        issues.push(
          `${key} ref UTxO not found: ${outRef.txHash}#${outRef.outputIndex}`,
        );
        refResults[key] = {
          requested,
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

      // Every reference script must sit at the permanent always-fails address.
      // Anywhere else it is an ordinary spendable UTxO that coin selection can
      // consume, which takes the deployment down for every consumer at once.
      const atDeployAddress = utxo.address === deployAddress;
      if (!atDeployAddress)
        issues.push(
          `${key} ref UTxO is at a spendable address, not the always-fails deployment address: ${utxo.address}`,
        );

      let scriptMatches = false;
      let onChainScriptHash: string | null = null;
      if (!utxo.scriptRef) {
        issues.push(`${key} ref UTxO has no scriptRef`);
      } else {
        onChainScriptHash = validatorToScriptHash(utxo.scriptRef);
        if (expectedScript) {
          scriptMatches =
            applyDoubleCborEncoding(utxo.scriptRef.script) ===
            applyDoubleCborEncoding(expectedScript.script);
          if (!scriptMatches)
            issues.push(
              `${key} scriptRef CBOR does not match the locally derived validator`,
            );
          if (onChainScriptHash !== expectedScriptHash)
            issues.push(
              `${key} on-chain script hash ${onChainScriptHash} != derived ${expectedScriptHash}`,
            );
        }
        // expectedScript === null only for governanceDispatcher/Voting with
        // no seed — the "no governanceSeed provided" issue above already
        // covers that case, so no additional mismatch noise here.
      }

      refResults[key] = {
        requested,
        outRef,
        found: true,
        atDeployAddress,
        scriptMatches,
        onChainScriptHash,
        expectedScriptHash,
        hashMatches:
          expectedScript != null && onChainScriptHash === expectedScriptHash,
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

    // The governance instance's voting stake credential. Every governance
    // endpoint carries a 0-ADA withdrawal from the voting validator, and the
    // ledger rejects a withdrawal from an unregistered account — so an instance
    // whose stake was never registered is inert, and fails only at submit time
    // with ConwayWithdrawalsMissingAccounts. Checked whenever a seed is given.
    let governanceVotingStake: StakeRegistrationCheck | null = null;
    if (governanceInstance !== null) {
      const rewardAddress = validatorToRewardAddress(
        network,
        governanceInstance.votingValidator,
      );
      const status = yield* stakeRegistrationStatus(lucid, rewardAddress);
      if (status === "not-registered")
        issues.push(
          "governance voting stake credential is not registered — every propose/vote/finalize/execute call will be rejected until registerVotingStake runs",
        );
      if (status === "unknown")
        issues.push(
          "governance voting stake registration state is not readable through this provider — verify with Blockfrost or the emulator",
        );
      governanceVotingStake = { rewardAddress, status };
    }

    // The two savings family stake credentials. Every savings operation carries
    // a 0-ADA withdrawal from its family, and the ledger rejects a withdrawal
    // from an unregistered account, so an unregistered family makes the whole
    // module inert and fails only at submit time.
    let savingsStakeRegistrations: Record<
      SavingsFamilyName,
      StakeRegistrationCheck
    > | null = null;
    if (savingsRequested) {
      const savingsModuleForStake =
        savingsModule ??
        (yield* Effect.tryPromise({
          try: () => import("../savings/validators.js"),
          catch: (e) =>
            new SetupError({
              message: `verifyProtocolDeployment: failed to load the savings module: ${e}`,
            }),
        }));
      const checks = {} as Record<SavingsFamilyName, StakeRegistrationCheck>;
      for (const family of SAVINGS_FAMILIES) {
        const rewardAddress = savingsModuleForStake.savingsFamilyRewardAddress(
          network,
          family,
        );
        const status = yield* stakeRegistrationStatus(lucid, rewardAddress);
        if (status === "not-registered")
          issues.push(
            `savings ${family} stake credential is not registered — every savings operation in that family will be rejected until registerSavingsStake runs`,
          );
        if (status === "unknown")
          issues.push(
            `savings ${family} stake registration state is not readable through this provider — verify with Blockfrost or the emulator`,
          );
        checks[family] = { rewardAddress, status };
      }
      savingsStakeRegistrations = checks;
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
      governanceVotingStake,
      savingsStakeRegistrations,
      registry,
    };
  });
