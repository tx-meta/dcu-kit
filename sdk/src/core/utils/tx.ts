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
 * Wraps an Effect program in a set of execution strategies.
 *
 * Provides three ways to run a program without committing to one at the call site:
 * - `unsafeRun()` — Promise that throws on failure (use in programWrapper / CLI).
 * - `safeRun()`   — Promise returning Either<E, A> (use when you need to inspect errors).
 * - `program()`   — Returns the raw Effect for further composition.
 *
 * @param program - Any Effect.Effect<A, E>.
 * @returns Object with `unsafeRun`, `safeRun`, and `program` methods.
 *
 * @example
 * ```typescript
 * export const createAccount = (lucid: LucidEvolution, config: CreateAccountConfig) =>
 *   makeReturn(unsignedCreateAccountTxProgram(lucid, config));
 *
 * // Caller chooses how to run it:
 * const tx = await createAccount(lucid, config).unsafeRun();
 * const result = await createAccount(lucid, config).safeRun(); // Either<DcuError, TxSignBuilder>
 * ```
 */
export const makeReturn = <A, E>(program: Effect.Effect<A, E>) => ({
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




