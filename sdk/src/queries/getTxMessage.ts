import { Effect } from "effect";
import { SetupError } from "../core/errors.js";
import { bfGet, type BlockfrostConfig } from "./blockfrost.js";
import { CIP20_LABEL } from "../core/utils/index.js";

export type { BlockfrostConfig };

/** One entry of Blockfrost's `/txs/{hash}/metadata` response. */
type BfTxMetadatum = {
  label: string;
  json_metadata: unknown;
};

/**
 * Reads back the CIP-20 transaction message (label 674) written by any endpoint's
 * `message` config field, rejoining the 64-byte chunks into the original text.
 *
 * This is the read half of the metadata pattern: where a datum commits to
 * `hashContent(text)` (escrow `content_hash`, `evidence`), load the pre-image
 * here, recompute with the same {@link hashContent}, and compare. Using one
 * canonical implementation on both sides is what stops app-side and
 * validator-side hashes from drifting apart.
 *
 * Read-only: builds no transaction and needs no wallet — only Blockfrost access.
 *
 * @param config - Blockfrost url + project id.
 * @param txHash - The transaction to read.
 * @returns The message text, or `null` when the transaction carries no CIP-20
 *   message (including an unknown transaction, which Blockfrost 404s).
 *
 * @example
 * ```ts
 * const terms = await Effect.runPromise(getTxMessage(bf, escrowCreateTxHash));
 * const verified = terms !== null && hashContent(terms) === datum.content_hash;
 * ```
 */
export const getTxMessage = (
  config: BlockfrostConfig,
  txHash: string,
): Effect.Effect<string | null, SetupError> =>
  Effect.gen(function* () {
    const body = yield* bfGet(config, `/txs/${txHash}/metadata`);
    if (!Array.isArray(body)) return null;

    const entry = (body as BfTxMetadatum[]).find(
      (m) => String(m?.label) === String(CIP20_LABEL),
    );
    if (!entry) return null;

    const payload = entry.json_metadata;
    if (typeof payload !== "object" || payload === null) return null;

    const msg = (payload as { msg?: unknown }).msg;
    if (typeof msg === "string") return msg;
    if (Array.isArray(msg) && msg.every((line) => typeof line === "string")) {
      return msg.join("");
    }
    return null;
  });
