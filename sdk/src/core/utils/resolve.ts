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
