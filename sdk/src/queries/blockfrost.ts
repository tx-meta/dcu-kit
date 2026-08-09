import { Effect, Schedule } from "effect";
import { SetupError } from "../core/errors.js";

/**
 * Minimal Blockfrost connection details for historical (read-only) queries.
 *
 * Unlike the tx-building endpoints, history cannot be answered from the current
 * UTxO set — a closed group has been burned and is no longer present at any
 * address, and transaction metadata is not part of any UTxO. The only source of
 * truth is transaction history, which Lucid's provider abstraction does not
 * expose. These readers therefore talk to the Blockfrost API directly. (A
 * Maestro variant could be added later behind the same reader shapes.)
 */
export type BlockfrostConfig = {
  /** Base URL including `/api/v0`, e.g. `https://cardano-preprod.blockfrost.io/api/v0`. */
  url: string;
  /** Blockfrost `project_id`. */
  projectId: string;
};

/** Aborts a stalled request rather than holding the socket open. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Bounded backoff for transient (network / 5xx) failures. */
const retrySchedule = Schedule.spaced("500 millis").pipe(
  Schedule.upTo("5 seconds"),
);

/** Issues a GET against Blockfrost; 404 → `null`, other non-2xx → `SetupError`. */
export const bfGet = (
  config: BlockfrostConfig,
  path: string,
): Effect.Effect<unknown, SetupError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${config.url}${path}`, {
        headers: { project_id: config.projectId },
        // Aborts the fetch (and frees the socket) if Blockfrost stalls.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(
          `Blockfrost ${res.status} for ${path}: ${await res.text()}`,
        );
      }
      return res.json();
    },
    catch: (e) =>
      new SetupError({ message: `Blockfrost query failed: ${e}`, cause: e }),
  }).pipe(Effect.retry(retrySchedule));

/** Trustworthy chain-tip slot for observation metadata. */
export const blockfrostTipSlot = (
  config: BlockfrostConfig,
): Effect.Effect<bigint, SetupError> =>
  Effect.flatMap(bfGet(config, "/blocks/latest"), (value) => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { slot?: unknown }).slot !== "number"
    )
      return Effect.fail(
        new SetupError({ message: "Blockfrost latest block omitted slot" }),
      );
    return Effect.succeed(BigInt((value as { slot: number }).slot));
  });
