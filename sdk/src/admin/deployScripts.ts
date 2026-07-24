import {
  Data,
  LucidEvolution,
  Script,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { Effect, Schedule } from "effect";
import {
  alwaysFailsValidator,
  Protocol,
} from "../core/validators/constants.js";
import { DcuError, TransactionBuildError, SetupError } from "../core/errors.js";
import { isDeployAllowed } from "../core/validators/registry.js";
import { getWalletAddress } from "../core/utils/index.js";
import {
  registerTreasuryStake,
  RegisterTreasuryStakeResult,
} from "./registerTreasuryStake.js";

/**
 * The hard ceiling for a deployable reference script: a deployment tx must carry
 * the full script, so it can never exceed maxTxSize (16,384) minus the measured
 * ~256-byte deploy-tx envelope. Scripts above this line can NEVER go on-chain —
 * the treasury split (spec 2026-07-04) exists because the monolith crossed it.
 */
export const MAX_REF_SCRIPT_BYTES = 16_128;

/**
 * Legacy per-script deposit floors (kept for the emulator context). The live
 * deploy computes the min-UTxO deposit per script from its actual size.
 */
export const TREASURY_REF_LOVELACE = 30_000_000n; // 30 ADA
export const GROUP_REF_LOVELACE = 26_000_000n; // 26 ADA

export type ScriptRefOutRef = { txHash: string; outputIndex: number };

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

/** Compiled size of a validator in bytes (script hex is CBOR-wrapped bytes). */
const scriptBytes = (script: Script): number => script.script.length / 2;

/**
 * Min-UTxO deposit for a reference-script UTxO, from the actual script size:
 * coinsPerUTxOByte (4,310) × (160-byte ledger overhead + output serialization
 * ≈ script + 300 B for address/value/datum), plus a 2-ADA cushion. The deposit
 * is locked permanently at the alwaysFails address, so it is computed tight
 * rather than over-provisioned.
 */
const refDepositLovelace = (script: Script): bigint =>
  BigInt((scriptBytes(script) + 460) * 4_310) + 2_000_000n;

/**
 * Polls the wallet address until the given txHash appears in the UTxO set.
 *
 * Blockfrost's wallet UTxO endpoint can lag behind chain state even after
 * awaitTx returns. Once this poll succeeds, completeProgram() for the next tx
 * will also see fresh UTxOs because both hit the same Blockfrost endpoint.
 *
 * Retries every 3 seconds for up to 30 seconds before failing.
 */
const awaitWalletIndexed = (
  lucid: LucidEvolution,
  address: string,
  txHash: string,
): Effect.Effect<void, SetupError, never> =>
  Effect.retry(
    Effect.tryPromise({
      try: async () => {
        const utxos = await lucid.utxosAt(address);
        if (!utxos.some((u) => u.txHash === txHash))
          throw new Error("not indexed yet");
      },
      catch: () =>
        new SetupError({
          message: `Timed out waiting for tx ${txHash.slice(0, 8)}... to appear in wallet UTxOs`,
        }),
    }),
    Schedule.spaced(3_000).pipe(Schedule.upTo(30_000)),
  );

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

    const deployAddress = validatorToAddress(
      network,
      alwaysFailsValidator.elseAlwaysFails,
    );

    const deployments: Array<[DeployedScriptKey, Script]> = [
      ["treasury", protocol.treasuryValidator.mintTreasury],
      ["group", protocol.groupValidator.spendGroup],
      ["treasuryRounds", protocol.treasuryStakeValidators.rounds],
      ["treasuryLifecycle", protocol.treasuryStakeValidators.lifecycle],
      ["treasuryRecovery", protocol.treasuryStakeValidators.recovery],
      ["treasuryReserve", protocol.treasuryStakeValidators.reserve],
    ];

    // Ceiling guard BEFORE any funds move: every script must be deployable.
    for (const [key, script] of deployments) {
      const bytes = scriptBytes(script);
      if (bytes > MAX_REF_SCRIPT_BYTES) {
        return yield* Effect.fail(
          new SetupError({
            message: `${key} validator is ${bytes} bytes — exceeds the ${MAX_REF_SCRIPT_BYTES}-byte deployable-reference-script ceiling and can never go on-chain`,
          }),
        );
      }
    }

    const refs = {} as Record<DeployedScriptKey, ScriptRefOutRef>;

    for (const [key, script] of deployments) {
      const txBuilder = yield* lucid
        .newTx()
        .pay.ToAddressWithData(
          deployAddress,
          { kind: "inline", value: Data.void() },
          { lovelace: refDepositLovelace(script) },
          { type: "PlutusV3", script: script.script },
        )
        .addSigner(address)
        .completeProgram()
        .pipe(
          Effect.mapError(
            (e) =>
              new TransactionBuildError({
                operation: `deployScripts:${key}:build`,
                error: String(e),
              }),
          ),
        );

      const signed = yield* Effect.tryPromise({
        try: () => txBuilder.sign.withWallet().complete(),
        catch: (e) =>
          new TransactionBuildError({
            operation: `deployScripts:${key}:sign`,
            error: String(e),
          }),
      });
      const txHash = yield* Effect.tryPromise({
        try: () => signed.submit(),
        catch: (e) =>
          new TransactionBuildError({
            operation: `deployScripts:${key}:submit`,
            error: String(e),
          }),
      });
      yield* Effect.tryPromise({
        try: () => lucid.awaitTx(txHash),
        catch: (e) =>
          new TransactionBuildError({
            operation: `deployScripts:${key}:confirm`,
            error: String(e),
          }),
      });

      // Guarantees the next completeProgram() sees fresh wallet UTxOs.
      yield* awaitWalletIndexed(lucid, address, txHash);

      refs[key] = { txHash, outputIndex: 0 };
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
