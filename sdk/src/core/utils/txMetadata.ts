/**
 * CIP-20 transaction-message metadata (label 674).
 *
 * Distinct from the CIP-68 datum metadata helpers in `datum.ts`: CIP-68 text
 * lives in a datum and is validator-visible, while CIP-20 text rides in the
 * transaction's auxiliary data. No validator in this protocol reads CIP-20, so
 * attaching it never affects a script hash, a datum, or min-ADA.
 */

import type { TxBuilder } from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { Effect } from "effect";
import { ConfigurationError } from "../errors.js";

const encoder = new TextEncoder();

/** CIP-20 transaction-message metadata label. */
export const CIP20_LABEL = 674;

/** Ledger cap on a single metadata text string. */
const MAX_METADATUM_STRING_BYTES = 64;

/**
 * Budget for one message, in UTF-8 bytes. Well inside the 16,384-byte tx limit
 * so metadata never competes with scripts, datums, and redeemers for space —
 * CIP-20 here is for summaries, not documents.
 */
export const MAX_TX_MESSAGE_BYTES = 1024;

/**
 * Budget for a governance proposal rationale (~650 words).
 *
 * Deliberately larger than the default: opening a proposal is rare and
 * high-stakes — members vote against this text — whereas the default guards
 * routine per-action memos, where the extra bytes are a recurring fee on every
 * contribution. Neither figure is a technical ceiling; measured transaction
 * headroom is many times both.
 */
export const MAX_PROPOSAL_MESSAGE_BYTES = 4096;

/** A transaction message: one line, or several the caller wants kept apart. */
export type TxMessage = string | readonly string[];

/**
 * Split `text` into chunks of at most `maxBytes` UTF-8 bytes, never cutting a
 * codepoint in half.
 *
 * Lucid's own metadata schema caps strings at 64 *characters*
 * (`S.String.pipe(S.maxLength(64))`) while the ledger caps them at 64 *bytes*,
 * so any non-ASCII text has to be chunked here rather than left to Lucid.
 */
export const chunkUtf8 = (text: string, maxBytes: number): string[] => {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  // Iterating a string with for..of walks codepoints, so surrogate pairs
  // (emoji) are measured and moved as a unit.
  for (const char of text) {
    const charBytes = encoder.encode(char).length;
    if (currentBytes + charBytes > maxBytes && current !== "") {
      chunks.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current !== "") chunks.push(current);

  return chunks;
};

/**
 * Validate a caller message and shape it into the CIP-20 payload
 * (`{ msg: [...] }`), chunked to the ledger's per-string byte limit.
 *
 * Validation happens here rather than in Lucid because Lucid asserts its
 * 64-character limit with a synchronous throw, which surfaces as an Effect
 * *defect* at completion time instead of a typed `DcuError` the caller can
 * handle.
 */
export const buildCip20Payload = (
  message: TxMessage,
  maxBytes: number = MAX_TX_MESSAGE_BYTES,
): Effect.Effect<{ msg: string[] }, ConfigurationError> =>
  Effect.gen(function* () {
    const lines = typeof message === "string" ? [message] : [...message];
    const totalBytes = lines.reduce(
      (sum, line) => sum + encoder.encode(line).length,
      0,
    );

    if (totalBytes > maxBytes) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "message",
          message: `message must be at most ${maxBytes} UTF-8 bytes (got ${totalBytes})`,
        }),
      );
    }

    const msg = lines.flatMap((line) =>
      chunkUtf8(line, MAX_METADATUM_STRING_BYTES),
    );

    if (msg.length === 0) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "message",
          message: "message must not be empty",
        }),
      );
    }

    return { msg };
  });

/**
 * `blake2b-256` of the exact UTF-8 bytes of `content`, as lowercase hex — the
 * pre-image commitment stored in a datum (escrow `content_hash`, `evidence`)
 * while the text itself rides in the transaction's CIP-20 metadata.
 *
 * Deliberately plain: no salt and no domain tag, so any third party holding the
 * public pre-image can reproduce it with a stock BLAKE2b implementation
 * (`b2sum -l 256`). That is the opposite of `computeProfileCommitment`, where a
 * salt is required precisely because a profile is low-entropy and must NOT be
 * reproducible by anyone who guesses it.
 *
 * No Unicode normalization is applied — the holder must retain the pre-image
 * byte-for-byte.
 */
export const hashContent = (content: string): string =>
  bytesToHex(blake2b(utf8ToBytes(content), { dkLen: 32 }));

/**
 * Attach a caller message to a transaction as CIP-20 metadata, or pass the
 * builder through untouched when no message was given.
 *
 * Must run before `completeProgram()`: metadata is part of the transaction
 * body, so it changes the size and therefore the fee. `TxSignBuilder` has no
 * equivalent method — a completed transaction can no longer be annotated.
 */
export const attachTxMessage = (
  tx: TxBuilder,
  message: TxMessage | undefined,
  maxBytes: number = MAX_TX_MESSAGE_BYTES,
): Effect.Effect<TxBuilder, ConfigurationError> =>
  message === undefined
    ? Effect.succeed(tx)
    : buildCip20Payload(message, maxBytes).pipe(
        Effect.map((payload) => tx.attachMetadata(CIP20_LABEL, payload)),
      );
