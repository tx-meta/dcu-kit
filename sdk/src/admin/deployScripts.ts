import { LucidEvolution, Script } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { Protocol } from "../core/validators/constants.js";
import { DcuError, SetupError } from "../core/errors.js";
import { isDeployAllowed } from "../core/validators/registry.js";
import { getWalletAddress } from "../core/utils/index.js";
import {
  assertDeployableSizes,
  MAX_REF_SCRIPT_BYTES,
  publishRefScript,
  refScriptDeployAddress,
  ScriptRefOutRef,
  spendableWalletUtxos,
} from "./refScripts.js";
import {
  registerTreasuryStake,
  RegisterTreasuryStakeResult,
} from "./registerTreasuryStake.js";

export { MAX_REF_SCRIPT_BYTES };
export type { ScriptRefOutRef };

/**
 * Legacy per-script deposit floors (kept for the emulator context). The live
 * deploy computes the min-UTxO deposit per script from its actual size.
 */
export const TREASURY_REF_LOVELACE = 30_000_000n; // 30 ADA
export const GROUP_REF_LOVELACE = 26_000_000n; // 26 ADA

/** The six rosca reference scripts a deployment publishes. */
export type DeployedScriptKey =
  | "treasury"
  | "group"
  | "treasuryRounds"
  | "treasuryLifecycle"
  | "treasuryRecovery"
  | "treasuryReserve";

export type DeployScriptsResult = {
  /** OutRef per deployed reference script (dispatcher, group, 4 family stakes). */
  refs: Record<DeployedScriptKey, ScriptRefOutRef>;
  /** OutRef of the treasury dispatcher reference UTxO (back-compat alias of refs.treasury). */
  treasuryRef: ScriptRefOutRef;
  /** OutRef of the group validator reference UTxO (back-compat alias of refs.group). */
  groupRef: ScriptRefOutRef;
  /** The alwaysFails script address the UTxOs were sent to. */
  deployAddress: string;
  /**
   * Registration outcomes for the four family stake credentials
   * (rounds/lifecycle/recovery/reserve) — the withdraw-zero prerequisite for
   * every treasury endpoint on this deployment.
   */
  stakeRegistrations: RegisterTreasuryStakeResult;
};

/**
 * Deploys the six rosca validators as reference scripts at a permanent
 * alwaysFails address — the treasury dispatcher, the group validator, and the
 * four treasury family stake validators (rounds / lifecycle / recovery /
 * reserve) — then registers the four family stake credentials.
 *
 * **Why alwaysFails?**
 * UTxOs at this address can never be spent — the validator always fails.
 * Reference scripts deposited here are permanently on-chain and safe to use
 * as `.readFrom()` inputs for the lifetime of the deployment.
 *
 * **Why one script per transaction?**
 * A deploy tx carries the full script; batching risks the 16,384-byte tx limit.
 * Every script is also individually guarded against {@link MAX_REF_SCRIPT_BYTES}
 * up front — an oversized validator is a build regression that can never deploy,
 * so it fails here with a clear message instead of a ledger size error.
 *
 * **Why poll between transactions?**
 * Blockfrost's wallet UTxO endpoint can lag behind the chain even after awaitTx
 * returns. The poll ensures each next completeProgram() sees the fresh UTxO set
 * so coin selection never picks a spent input.
 *
 * **Registrations (after the deposits):** the four family stake credentials —
 * a one-time prerequisite for every treasury endpoint (each carries a 0-ADA
 * family withdrawal). Duplicate registrations are treated as success, so
 * re-running on an existing deployment does not fail.
 *
 * @param protocol - The deployment's protocol context. Build with `buildProtocol`.
 * @param lucid - Lucid instance with admin wallet selected (live network only).
 * @returns Effect yielding `DeployScriptsResult` with the six on-chain OutRefs.
 */
export const deployScripts = (
  protocol: Protocol,
  lucid: LucidEvolution,
): Effect.Effect<DeployScriptsResult, DcuError, never> =>
  Effect.gen(function* () {
    const address = yield* getWalletAddress(lucid);
    const network = lucid.config().network!;

    // Launch-surface freeze: Mainnet deployment is allowed only for families
    // marked `launch` in validator-registry.json (see VERSIONING.md).
    if (!isDeployAllowed("rosca", network)) {
      return yield* Effect.fail(
        new SetupError({
          message:
            "rosca is not marked 'launch' in validator-registry.json — Mainnet deployment is frozen",
        }),
      );
    }

    const deployAddress = refScriptDeployAddress(lucid);

    const deployments: Array<[DeployedScriptKey, Script]> = [
      ["treasury", protocol.treasuryValidator.mintTreasury],
      ["group", protocol.groupValidator.spendGroup],
      ["treasuryRounds", protocol.treasuryStakeValidators.rounds],
      ["treasuryLifecycle", protocol.treasuryStakeValidators.lifecycle],
      ["treasuryRecovery", protocol.treasuryStakeValidators.recovery],
      ["treasuryReserve", protocol.treasuryStakeValidators.reserve],
    ];

    // Ceiling guard BEFORE any funds move: every script must be deployable.
    yield* assertDeployableSizes(deployments);

    const refs = {} as Record<DeployedScriptKey, ScriptRefOutRef>;

    for (const [key, script] of deployments) {
      // Re-read per iteration: the previous deploy consumed inputs and made a
      // new change UTxO, and reference-script UTxOs are never spendable here.
      const presetWalletInputs = yield* spendableWalletUtxos(lucid);
      refs[key] = yield* publishRefScript(lucid, {
        key,
        script,
        deployAddress,
        walletAddress: address,
        presetWalletInputs,
        operation: "deployScripts",
      });
    }

    // Register the four family stake credentials (withdraw-zero prerequisite for
    // every treasury endpoint; duplicate registration = success).
    const stakeRegistrations = yield* registerTreasuryStake(protocol, lucid);

    return {
      refs,
      treasuryRef: refs.treasury,
      groupRef: refs.group,
      deployAddress,
      stakeRegistrations,
    };
  });
