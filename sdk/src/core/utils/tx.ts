import { TxSignBuilder, LucidEvolution } from "@lucid-evolution/lucid";
import { Effect, Either, Schedule } from "effect";
import { LucidError, TransactionBuildError } from "../errors.js";

/**
 * Utility for handling transaction lifecycle (building, signing, submission, and confirmation).
 */

/**
 * Signs a transaction with the currently selected wallet and submits it to the network.
 * 
 * @param tx - The unsigned transaction builder.
 * @returns Effect yielding the transaction hash or a LucidError.
 */
export const signAndSubmit = (
  tx: TxSignBuilder
): Effect.Effect<string, LucidError, never> =>
  Effect.gen(function* () {
    const signed = yield* Effect.tryPromise({
      try: () => tx.sign.withWallet().complete(),
      catch: (error) => new LucidError({ message: "Failed to sign transaction", cause: error })
    });
    return yield* Effect.tryPromise({
      try: () => signed.submit(),
      catch: (error) => new LucidError({ message: "Failed to submit transaction", cause: error })
    });
  });

/**
 * Wraps the transaction building block in an Effect.
 * 
 * Provides consistent error reporting using TransactionBuildError.
 * 
 * @param operation - A descriptive name for the operation (e.g., "createAccount").
 * @param f - An async function that constructs and returns a TxSignBuilder.
 * @returns Effect yielding TxSignBuilder or TransactionBuildError.
 */
export const tryBuildTx = (
  operation: string,
  f: () => Promise<TxSignBuilder>
): Effect.Effect<TxSignBuilder, TransactionBuildError> =>
  Effect.tryPromise({
    try: f,
    catch: (error) => new TransactionBuildError({ operation, error: String(error) }),
  });

/**
 * The three execution strategies returned by every DCU SDK endpoint.
 *
 * Choose the one that fits your call site:
 * - `unsafeRun()` for scripts and examples (throws on error)
 * - `safeRun()`   for application code that needs to inspect errors
 * - `program()`   for Effect-native code that composes further
 */
export interface ProgramRunner<A, E> {
  /**
   * Executes the program and returns a Promise.
   * Throws if the program fails — best for top-level scripts and CLI usage.
   *
   * @example
   * const tx = await createAccount(lucid, config).unsafeRun();
   */
  unsafeRun(): Promise<A>;

  /**
   * Executes the program and returns a Promise of `Either<E, A>`.
   * Never throws — inspect `Either.isLeft` / `Either.isRight` to handle errors.
   *
   * @example
   * const result = await createAccount(lucid, config).safeRun();
   * if (Either.isLeft(result)) console.error(result.left);
   */
  safeRun(): Promise<Either.Either<A, E>>;

  /**
   * Returns the raw `Effect.Effect<A, E>` for composing with other Effects.
   * Use this when you are inside an `Effect.gen` block.
   *
   * @example
   * const tx = yield* createAccount(lucid, config).program();
   */
  program(): Effect.Effect<A, E>;
}

/**
 * Wraps an Effect program in a `ProgramRunner` so callers can choose
 * how to execute it without committing to Effect at the call site.
 */
export const makeReturn = <A, E>(program: Effect.Effect<A, E>): ProgramRunner<A, E> => ({
  unsafeRun: () => Effect.runPromise(program),
  safeRun:   () => Effect.runPromise(Effect.either(program)),
  program:   () => program,
});

/**
 * Polls the network to confirm that a transaction has been successfully indexed.
 * 
 * Uses an Effect-native retry mechanism with an exponential/spaced schedule.
 * 
 * @param lucid - The current Lucid instance.
 * @param txHash - The hash of the transaction to wait for.
 * @param intervalMs - Polling interval in milliseconds (default: 5000).
 * @param maxRetries - Maximum number of retries (default: 24, ~2 mins total).
 * @returns Effect yielding true if confirmed, or false if timed out.
 */
export const waitForTx = (
    lucid: LucidEvolution,
    txHash: string,
    intervalMs = 5000,
    maxRetries = 24
): Effect.Effect<boolean, LucidError, never> => 
    Effect.tryPromise({
        try: async () => {
            const utxos = await lucid.utxosByOutRef([{ txHash, outputIndex: 0 }]);
            if (utxos.length === 0) throw new Error("Tx not found yet");
            return true;
        },
        catch: (e) => e
    }).pipe(
        Effect.retry({
            schedule: Schedule.spaced(intervalMs).pipe(Schedule.upTo(intervalMs * maxRetries)),
        }),
        Effect.catchAll(() => Effect.succeed(false))
    );




