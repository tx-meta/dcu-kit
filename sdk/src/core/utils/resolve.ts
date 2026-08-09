import { LucidEvolution, UTxO, OutRef } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  AmbiguousUtxoError,
  LucidError,
  UtxoNotFoundError,
} from "../errors.js";

/**
 * Matches the Lucid Evolution failure raised when a unit is held by more than one
 * UTxO or address. String matching is a heuristic: it is the only signal Lucid gives
 * for this case. Structural detection lives in `resolveTreasuryUtxoForGroup`, which
 * counts candidates directly.
 */
const isMultiMatchMessage = (reason: string): boolean =>
  /needs to be an NFT|only held by one address/i.test(reason);

/** Provider messages that specifically mean the requested unit is absent. */
const isNotFoundMessage = (reason: string): boolean =>
  /\b404\b|not found|no UTxO|could not find/i.test(reason);

export const resolveUtxoByUnit = (
  lucid: LucidEvolution,
  unit: string,
): Effect.Effect<UTxO, UtxoNotFoundError | AmbiguousUtxoError | LucidError> =>
  Effect.tryPromise({
    try: () => lucid.utxoByUnit(unit),
    catch: (e) => {
      const reason = String(e);
      if (isMultiMatchMessage(reason))
        return new AmbiguousUtxoError({
          unit,
          // A floor, not a count: Lucid rejects without reporting how many it saw.
          candidates: 2,
          message: `${unit} is held by more than one UTxO: ${reason}`,
          cause: e,
        });
      if (isNotFoundMessage(reason))
        return new UtxoNotFoundError({
          tokenName: unit,
          address: "chain",
          message: reason,
          cause: e,
        });
      return new LucidError({
        message: `provider failed while resolving unit ${unit}`,
        cause: e,
      });
    },
  }).pipe(
    Effect.filterOrFail(
      (utxo): utxo is UTxO => utxo != null,
      () =>
        new UtxoNotFoundError({
          tokenName: unit,
          address: "chain",
          message: `no UTxO on chain holds ${unit}`,
        }),
    ),
  );

export const resolveUtxoByOutRef = (
  lucid: LucidEvolution,
  outRef: OutRef,
): Effect.Effect<UTxO, UtxoNotFoundError | LucidError> =>
  Effect.tryPromise({
    try: () => lucid.utxosByOutRef([outRef]),
    catch: (cause) =>
      new LucidError({
        message: `provider failed while resolving ${outRef.txHash}#${outRef.outputIndex}`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((utxos) =>
      utxos[0]
        ? Effect.succeed(utxos[0])
        : Effect.fail(
            new UtxoNotFoundError({
              tokenName: `${outRef.txHash}#${outRef.outputIndex}`,
              address: "chain",
              message: "provider returned no live UTxO for the out-ref",
            }),
          ),
    ),
  );

/**
 * Computes a UTxO's index within the canonically-ordered `reference_inputs` list of a
 * transaction. Cardano sorts inputs (and reference inputs) by (txHash bytes, output
 * index); for equal-length hex txHashes a lexicographic string compare matches the
 * ledger's byte ordering. Use this for redeemer fields like `group_ref_input_index`
 * that must point into the on-chain `reference_inputs` list — hardcoding `0n` is only
 * correct when the group is the sole reference input (no longer true since the P5
 * settings UTxO is also referenced).
 */
export const referenceInputIndex = (
  referenceInputs: UTxO[],
  target: UTxO,
): bigint => {
  const sorted = [...referenceInputs].sort((a, b) =>
    a.txHash === b.txHash
      ? a.outputIndex - b.outputIndex
      : a.txHash < b.txHash
        ? -1
        : 1,
  );
  const idx = sorted.findIndex(
    (u) => u.txHash === target.txHash && u.outputIndex === target.outputIndex,
  );
  if (idx < 0)
    throw new Error(
      `referenceInputIndex: target ${target.txHash}#${target.outputIndex} not found in reference inputs`,
    );
  return BigInt(idx);
};
