import { Effect, Schedule } from "effect";
import { Emulator, LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { SetupError } from "../src/core/errors.js";

/**
 * Advance the emulator by `blocks` blocks (synchronous). No-op on live networks.
 * Always returns an Effect so every caller can `yield*` uniformly without branching.
 */
export const advanceBlock = (
  emulator: Emulator | undefined,
  blocks = 1,
): Effect.Effect<void, never, never> =>
  emulator ? Effect.sync(() => emulator.awaitBlock(blocks)) : Effect.void;

/**
 * Poll a script address until a UTxO matching `predicate` is found.
 * Retries every `retryIntervalMs` (default 5 s) for up to `maxWaitMs` (default 60 s).
 * On the emulator this succeeds immediately after `advanceBlock`; on live networks
 * it tolerates indexer lag.
 */
export const awaitScriptUtxo = (
  lucid: LucidEvolution,
  address: string,
  predicate: (u: UTxO) => boolean,
  errorMessage: string,
  opts?: { retryIntervalMs?: number; maxWaitMs?: number },
): Effect.Effect<UTxO, SetupError, never> => {
  const retryIntervalMs = opts?.retryIntervalMs ?? 5_000;
  const maxWaitMs = opts?.maxWaitMs ?? 60_000;

  return Effect.tryPromise({
    try: async () => {
      const utxos = await lucid.utxosAt(address);
      const found = utxos.find(predicate);
      if (!found) throw new Error(errorMessage);
      return found;
    },
    catch: (e) => e,
  }).pipe(
    Effect.retry({ schedule: Schedule.spaced(retryIntervalMs).pipe(Schedule.upTo(maxWaitMs)) }),
    Effect.catchAll(() => Effect.fail(new SetupError({ message: errorMessage }))),
  );
};

/**
 * Poll the connected wallet until a UTxO matching `predicate` is found.
 * Retries every `retryIntervalMs` (default 5 s) for up to `maxWaitMs` (default 60 s).
 */
export const awaitWalletUtxo = (
  lucid: LucidEvolution,
  predicate: (u: UTxO) => boolean,
  errorMessage: string,
  opts?: { retryIntervalMs?: number; maxWaitMs?: number },
): Effect.Effect<UTxO, SetupError, never> => {
  const retryIntervalMs = opts?.retryIntervalMs ?? 5_000;
  const maxWaitMs = opts?.maxWaitMs ?? 60_000;

  return Effect.tryPromise({
    try: async () => {
      const utxos = await lucid.wallet().getUtxos();
      const found = utxos.find(predicate);
      if (!found) throw new Error(errorMessage);
      return found;
    },
    catch: (e) => e,
  }).pipe(
    Effect.retry({ schedule: Schedule.spaced(retryIntervalMs).pipe(Schedule.upTo(maxWaitMs)) }),
    Effect.catchAll(() => Effect.fail(new SetupError({ message: errorMessage }))),
  );
};

/**
 * Fetch all UTxOs at a script address that were produced by `txHash`.
 * Single attempt — use after `advanceBlock` when emulator consistency is guaranteed,
 * or when the live-network call is made immediately after confirmation.
 */
export const fetchScriptUtxosByTxHash = (
  lucid: LucidEvolution,
  address: string,
  txHash: string,
  errorMessage: string,
): Effect.Effect<UTxO[], SetupError, never> =>
  Effect.tryPromise({
    try: () => lucid.utxosAt(address),
    catch: (e) => new SetupError({ message: `${errorMessage}: ${e}` }),
  }).pipe(
    Effect.map((utxos) => utxos.filter((u) => u.txHash === txHash)),
  );
