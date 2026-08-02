import {
  LucidEvolution,
  Script,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, SetupError } from "../core/errors.js";
import { FamilyName, isDeployAllowed } from "../core/validators/registry.js";
import { getWalletAddress } from "../core/utils/index.js";
import {
  assertDeployableSizes,
  publishRefScript,
  refScriptDeployAddress,
  ScriptRefOutRef,
  spendableWalletUtxos,
} from "./refScripts.js";

/**
 * The standalone-module reference scripts. Each belongs to a validator family
 * that ships beside ROSCA rather than inside it, so they are deployed by key
 * rather than derived from a `Protocol`.
 *
 * Only `savings` and `escrowV2` are large enough that a reference is required;
 * `pool` (4.1 KB) and `project` (2.3 KB) fit inline, and their references buy
 * transaction headroom and verifier coverage rather than feasibility.
 */
export type ModuleScriptKey =
  | "savings"
  | "escrowV2"
  | "pool"
  | "project"
  | "governanceDispatcher"
  | "governanceVoting";

/** The registry family each module key is frozen against (see VERSIONING.md). */
const MODULE_FAMILY: Record<ModuleScriptKey, FamilyName> = {
  savings: "savings",
  escrowV2: "escrow",
  pool: "escrow",
  project: "escrow",
  governanceDispatcher: "governance",
  governanceVoting: "governance",
};

/**
 * The scripts to publish, keyed by module. Omit a key to leave that module
 * alone — savings and escrow v2 are fixed validators, while the two governance
 * scripts come from a seeded `GovernanceInstance`.
 */
export type ModuleScriptSelection = Partial<Record<ModuleScriptKey, Script>>;

/** Whether a key was published in this run or already satisfied on-chain. */
export type ModuleRefStatus = "deployed" | "reused";

export type DeployModuleScriptsResult = {
  /** OutRef per requested key — newly published or the reused existing one. */
  refs: Partial<Record<ModuleScriptKey, ScriptRefOutRef>>;
  /** What happened per requested key. */
  status: Partial<Record<ModuleScriptKey, ModuleRefStatus>>;
  /** The alwaysFails script address the reference scripts live at. */
  deployAddress: string;
};

export type DeployModuleScriptsOptions = {
  /**
   * Reference scripts already recorded for this deployment. A key whose UTxO is
   * still on-chain, carries the same script hash, and sits at the always-fails
   * address is reused rather than republished, so re-running is safe and cheap.
   *
   * A recorded UTxO at any OTHER address is republished: wherever it sits, it
   * is spendable, and that is the failure this function exists to correct.
   *
   * A recorded UTxO carrying a DIFFERENT hash means the validator was upgraded:
   * the new script is published alongside and the old ref is left untouched, so
   * positions bound to the old hash stay spendable.
   */
  existing?: Partial<Record<ModuleScriptKey, ScriptRefOutRef>>;
  /**
   * Overrides how the deploy waits for the chain between transactions. The
   * default polls the provider's wallet UTxO endpoint; the Lucid emulator
   * never advances on its own, so emulator callers pass a block-advancing wait.
   */
  awaitSettled?: (txHash: string) => Effect.Effect<void, DcuError, never>;
};

/**
 * Whether a recorded OutRef can be reused as-is: it must still exist, carry the
 * requested script, AND sit at the always-fails deploy address. A reference at
 * any other address is spendable, so reusing it would bless exactly the custody
 * mistake this function exists to correct — it is republished instead.
 */
const existingRefIsSound = (
  lucid: LucidEvolution,
  ref: ScriptRefOutRef,
  script: Script,
  deployAddress: string,
): Effect.Effect<boolean, SetupError, never> =>
  Effect.tryPromise({
    try: async () => {
      const [utxo] = await lucid.utxosByOutRef([ref]);
      if (!utxo?.scriptRef) return false;
      if (utxo.address !== deployAddress) return false;
      return (
        validatorToScriptHash(utxo.scriptRef) === validatorToScriptHash(script)
      );
    },
    catch: (e) =>
      new SetupError({
        message: `Failed to resolve recorded reference script ${ref.txHash.slice(0, 8)}...#${ref.outputIndex}: ${String(e)}`,
      }),
  });

/**
 * Deploys standalone-module validators as reference scripts at the permanent
 * alwaysFails address — the same destination and the same guards
 * `deployScripts()` uses for the six ROSCA refs.
 *
 * **Why alwaysFails?**
 * A reference script parked at the deployer's own address is an ordinary
 * spendable UTxO. Lucid excludes reference-script UTxOs from coin selection
 * only when they were passed via `readFrom`, so a wallet-held one can be
 * selected to fund an unrelated transaction and the deployed script is gone.
 * At the alwaysFails address it can never be spent by anyone, including the
 * deployer. The deposit is the price of that guarantee.
 *
 * **Idempotent.** Pass `options.existing` and any key whose recorded UTxO is
 * still on-chain with the same script hash is reused instead of republished.
 *
 * **Upgrades keep the old reference.** When a recorded ref carries a different
 * hash, the new script is published and the old UTxO is left where it is — it
 * can never be spent, so transactions still bound to the old hash keep working.
 *
 * **One script per transaction**, each guarded against the deployable-reference
 * ceiling before any funds move, with a wallet-indexing poll between txs.
 *
 * @param scripts - The module scripts to publish, keyed by module.
 * @param lucid - Lucid instance with the paying wallet selected (live network).
 * @param options - Optional recorded refs to reuse.
 * @returns Effect yielding the OutRef and outcome for every requested key.
 */
export const deployModuleScripts = (
  scripts: ModuleScriptSelection,
  lucid: LucidEvolution,
  options: DeployModuleScriptsOptions = {},
): Effect.Effect<DeployModuleScriptsResult, DcuError, never> =>
  Effect.gen(function* () {
    const address = yield* getWalletAddress(lucid);
    const network = lucid.config().network!;
    const deployAddress = refScriptDeployAddress(lucid);

    const requested = (
      Object.entries(scripts) as Array<[ModuleScriptKey, Script | undefined]>
    ).filter((entry): entry is [ModuleScriptKey, Script] => !!entry[1]);

    if (requested.length === 0) {
      return yield* Effect.fail(
        new SetupError({
          message:
            "deployModuleScripts was called with no scripts — pass at least one of savings, escrowV2, pool, project, governanceDispatcher, governanceVoting",
        }),
      );
    }

    // Launch-surface freeze: Mainnet deployment is allowed only for families
    // marked `launch` in validator-registry.json (see VERSIONING.md).
    for (const family of new Set(
      requested.map(([key]) => MODULE_FAMILY[key]),
    )) {
      if (!isDeployAllowed(family, network)) {
        return yield* Effect.fail(
          new SetupError({
            message: `${family} is not marked 'launch' in validator-registry.json — Mainnet deployment is frozen`,
          }),
        );
      }
    }

    // Ceiling guard BEFORE any funds move: every script must be deployable.
    yield* assertDeployableSizes(requested);

    const refs: Partial<Record<ModuleScriptKey, ScriptRefOutRef>> = {};
    const status: Partial<Record<ModuleScriptKey, ModuleRefStatus>> = {};

    for (const [key, script] of requested) {
      const recorded = options.existing?.[key];
      if (
        recorded &&
        (yield* existingRefIsSound(lucid, recorded, script, deployAddress))
      ) {
        refs[key] = recorded;
        status[key] = "reused";
        continue;
      }

      // Re-read per iteration: the previous deploy consumed inputs and made a
      // new change UTxO, and reference-script UTxOs are never spendable here.
      const presetWalletInputs = yield* spendableWalletUtxos(lucid);
      refs[key] = yield* publishRefScript(lucid, {
        key,
        script,
        deployAddress,
        walletAddress: address,
        presetWalletInputs,
        operation: "deployModuleScripts",
        awaitSettled: options.awaitSettled,
      });
      status[key] = "deployed";
    }

    return { refs, status, deployAddress };
  });
