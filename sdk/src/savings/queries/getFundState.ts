import { LucidEvolution } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  LucidError,
  UtxoNotFoundError,
} from "../../core/errors.js";
import { SavingsFundFields } from "../types.js";
import { fundAssetUnit, resolveFund } from "../utils.js";

export type FundState = {
  fund: SavingsFundFields;
  /** The vault's current balance in the fund asset (base units). */
  vaultBalance: bigint;
  /** "Active" | "SharingOut" */
  phase: "Active" | "SharingOut";
};

/** Reads a fund anchor's parsed charter, totals, status, and vault balance. */
export const getFundStateProgram = (
  lucid: LucidEvolution,
  fundTokenName: string,
): Effect.Effect<
  FundState,
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const { utxo, fund } = yield* resolveFund(lucid, fundTokenName);
    return {
      fund,
      vaultBalance: utxo.assets[fundAssetUnit(fund)] ?? 0n,
      phase: fund.status === "Active" ? "Active" : "SharingOut",
    } as FundState;
  });

export const getFundState = (lucid: LucidEvolution, fundTokenName: string) =>
  Effect.runPromise(getFundStateProgram(lucid, fundTokenName));
