import { LucidEvolution, UTxO, OutRef } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { UtxoNotFoundError } from "../errors.js";

export const resolveUtxoByUnit = (
  lucid: LucidEvolution,
  unit: string,
): Effect.Effect<UTxO, UtxoNotFoundError> =>
  Effect.tryPromise({
    try: () => lucid.utxoByUnit(unit),
    catch: () => new UtxoNotFoundError({ tokenName: unit, address: "chain" }),
  }).pipe(
    Effect.filterOrFail(
      (utxo): utxo is UTxO => utxo != null,
      () => new UtxoNotFoundError({ tokenName: unit, address: "chain" }),
    ),
  );

export const resolveUtxoByOutRef = (
  lucid: LucidEvolution,
  outRef: OutRef,
): Effect.Effect<UTxO, UtxoNotFoundError> =>
  Effect.tryPromise({
    try: async () => {
      const utxos = await lucid.utxosByOutRef([outRef]);
      if (!utxos[0]) throw new Error("not found");
      return utxos[0];
    },
    catch: () =>
      new UtxoNotFoundError({
        tokenName: `${outRef.txHash}#${outRef.outputIndex}`,
        address: "chain",
      }),
  });

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
