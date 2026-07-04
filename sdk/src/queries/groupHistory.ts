import { Effect, Schedule } from "effect";
import { GroupDatum } from "../core/types.js";
import { DcuError, SetupError } from "../core/errors.js";
import { assetNameLabels } from "../core/utils/assets.js";
import {
  parseGroupCip68Datum,
  decodeGroupMetadata,
} from "../core/utils/datum.js";
import { makeReturn } from "../core/utils/index.js";

/**
 * Minimal Blockfrost connection details for historical (read-only) queries.
 *
 * Unlike the tx-building endpoints, group history cannot be answered from the
 * current UTxO set — a closed group has been burned and is no longer present at
 * any address. The only source of truth is transaction history, which Lucid's
 * provider abstraction does not expose. This reader therefore talks to the
 * Blockfrost API directly. (A Maestro variant could be added later behind the
 * same `GroupHistory` shape.)
 */
export type BlockfrostConfig = {
  /** Base URL including `/api/v0`, e.g. `https://cardano-preprod.blockfrost.io/api/v0`. */
  url: string;
  /** Blockfrost `project_id`. */
  projectId: string;
};

/** Lifecycle phase of a group at a given transaction. */
export type GroupAction = "created" | "updated" | "closed";

export type GroupHistoryEntry = {
  txHash: string;
  blockHeight: number;
  /** Block timestamp, Unix seconds. */
  blockTime: number;
  action: GroupAction;
  /**
   * Decoded group state carried by the continuing output at this tx.
   * `null` on the closing (burn) tx — there is no continuing output.
   */
  datum: GroupDatum | null;
  /** CIP-68 display metadata (name/description); `null` on close. */
  metadata: { name?: string; description?: string } | null;
};

export type GroupHistory = {
  groupPolicyId: string;
  tokenSuffix: string;
  /** The CIP-68 reference (100) asset unit that carries the group datum. */
  refUnit: string;
  /** `true` while the group's ref token is unburned (still live on-chain). */
  isLive: boolean;
  /** Chronological lifecycle, oldest first. */
  timeline: GroupHistoryEntry[];
};

// --- Blockfrost response shapes (only the fields this reader reads) ---

type BfAssetTx = {
  tx_hash: string;
  block_height: number;
  block_time: number;
  /** Position of the tx within its block — tiebreak for same-block ordering. */
  tx_index: number;
};

type BfHistoryAction = {
  tx_hash: string;
  action: "minted" | "burned";
};

type BfTxOutput = {
  inline_datum: string | null;
  amount: { unit: string; quantity: string }[];
};

type BfTxUtxos = { outputs: BfTxOutput[] };

type BfTx = { block_height: number; block_time: number; index: number };

const PAGE_SIZE = 100;
/** Per-request timeout; a stalled connection aborts rather than hanging the query. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Max concurrent Blockfrost requests when fanning out over a group's transactions. */
const FETCH_CONCURRENCY = 8;
/** Bounded backoff for transient (network / 5xx) failures. */
const retrySchedule = Schedule.spaced("500 millis").pipe(
  Schedule.upTo("5 seconds"),
);

/** Issues a GET against Blockfrost; 404 → `null`, other non-2xx → `SetupError`. */
const bfGet = (
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

/** Walks the paginated asset-transactions endpoint (ascending) to completion. */
const fetchAllTxs = (
  config: BlockfrostConfig,
  refUnit: string,
): Effect.Effect<BfAssetTx[], SetupError> =>
  Effect.gen(function* () {
    const all: BfAssetTx[] = [];
    let page = 1;
    while (true) {
      const batch = (yield* bfGet(
        config,
        `/assets/${refUnit}/transactions?order=asc&page=${page}`,
      )) as BfAssetTx[] | null;
      if (!batch || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      page += 1;
    }
    return all;
  });

/**
 * Reconstructs the full on-chain lifecycle of a group — including closed/burned
 * groups — from transaction history.
 *
 * A group is identified by its deployment's group policy id plus the permanent
 * 28-byte CIP-68 token suffix (the same `tokenSuffix` used by the spend
 * endpoints). For every transaction that touched the group's reference token, in
 * order, the reader fetches the continuing output and decodes its `GroupDatum`,
 * yielding a step-by-step timeline from creation to closure.
 *
 * Read-only: builds no transaction and needs no wallet — only Blockfrost access.
 *
 * @param config      - Blockfrost url + project id.
 * @param groupPolicyId - The deployment's group validator/policy hash (28-byte hex).
 * @param tokenSuffix - The group's permanent 28-byte CIP-68 suffix (no label prefix).
 * @returns Effect yielding the decoded {@link GroupHistory}.
 *
 * @example
 * const history = await getGroupHistory(bf, groupPolicyId, suffix).unsafeRun();
 * for (const step of history.timeline) {
 *   console.log(step.action, step.datum?.member_count, step.datum?.last_distributed_round);
 * }
 */
export const getGroupHistoryProgram = (
  config: BlockfrostConfig,
  groupPolicyId: string,
  tokenSuffix: string,
): Effect.Effect<GroupHistory, DcuError> =>
  Effect.gen(function* () {
    const refUnit = `${groupPolicyId}${assetNameLabels.prefix100}${tokenSuffix}`;

    const txs = yield* fetchAllTxs(config, refUnit);

    // Classify each tx by the mint/burn action recorded against the ref token.
    const history =
      ((yield* bfGet(config, `/assets/${refUnit}/history`)) as
        BfHistoryAction[] | null) ?? [];
    const actionByTx = new Map(history.map((h) => [h.tx_hash, h.action]));

    // Blockfrost's `/transactions` lists only txs that leave the token in an
    // output, so the closing burn (token consumed, never re-output) is absent.
    // Pull any such history tx — notably the burn — in from `/history` and fetch
    // its block info so the timeline reaches the actual closure.
    const known = new Set(txs.map((t) => t.tx_hash));
    const missing = history.filter((h) => !known.has(h.tx_hash));
    const fetched = yield* Effect.forEach(
      missing,
      (h) =>
        Effect.map(bfGet(config, `/txs/${h.tx_hash}`), (raw) => {
          const tx = raw as BfTx | null;
          return tx
            ? ({
                tx_hash: h.tx_hash,
                block_height: tx.block_height,
                block_time: tx.block_time,
                tx_index: tx.index,
              } satisfies BfAssetTx)
            : null;
        }),
      { concurrency: FETCH_CONCURRENCY },
    );
    const extra = fetched.filter((t): t is BfAssetTx => t !== null);
    // Chronological order: block height, then tx position within the block so
    // multiple group txs in one block (e.g. update then close) never reorder.
    const allTxs = [...txs, ...extra].sort(
      (a, b) => a.block_height - b.block_height || a.tx_index - b.tx_index,
    );

    // Fan out the per-tx UTxO fetches concurrently; Effect.forEach preserves the
    // (already chronological) input order, so the timeline stays ordered.
    const timeline: GroupHistoryEntry[] = yield* Effect.forEach(
      allTxs,
      (tx) =>
        Effect.gen(function* () {
          const minted = actionByTx.get(tx.tx_hash) === "minted";
          const burned = actionByTx.get(tx.tx_hash) === "burned";
          const action: GroupAction = burned
            ? "closed"
            : minted
              ? "created"
              : "updated";

          let datum: GroupDatum | null = null;
          let metadata: { name?: string; description?: string } | null = null;

          // The closing tx burns the ref token — no continuing output to decode.
          if (!burned) {
            const utxos = (yield* bfGet(
              config,
              `/txs/${tx.tx_hash}/utxos`,
            )) as BfTxUtxos | null;
            const out = utxos?.outputs.find(
              (o) =>
                o.inline_datum != null &&
                o.amount.some((a) => a.unit === refUnit),
            );
            if (out?.inline_datum) {
              const parts = yield* parseGroupCip68Datum(out.inline_datum);
              datum = parts.groupDatum;
              metadata = decodeGroupMetadata(parts.metadata);
            }
          }

          return {
            txHash: tx.tx_hash,
            blockHeight: tx.block_height,
            blockTime: tx.block_time,
            action,
            datum,
            metadata,
          } satisfies GroupHistoryEntry;
        }),
      { concurrency: FETCH_CONCURRENCY },
    );

    const isLive = !history.some((h) => h.action === "burned");
    return { groupPolicyId, tokenSuffix, refUnit, isLive, timeline };
  });

/**
 * {@link getGroupHistoryProgram} wrapped in a `ProgramRunner` for the standard
 * `unsafeRun()` / `safeRun()` / `program()` call sites.
 */
export const getGroupHistory = (
  config: BlockfrostConfig,
  groupPolicyId: string,
  tokenSuffix: string,
) => makeReturn(getGroupHistoryProgram(config, groupPolicyId, tokenSuffix));
