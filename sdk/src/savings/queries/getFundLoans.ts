import { LucidEvolution, Network, UTxO } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { LucidError } from "../../core/errors.js";
import {
  getUtxosAt,
  parseSafeDatum,
  patchInlineDatum,
} from "../../core/utils/index.js";
import {
  LoanAccountFields,
  SavingsDatum,
  SavingsDatumSchema,
} from "../types.js";
import { savingsVaultAddress } from "../utils.js";
import { savingsPolicyId } from "../validators.js";

export type FundLoan = {
  loanTokenName: string;
  loan: LoanAccountFields;
  utxo: UTxO;
};

/** Lists a fund's live loan records (scan of the vault address). */
export const getFundLoansProgram = (
  lucid: LucidEvolution,
  fundTokenName: string,
): Effect.Effect<FundLoan[], LucidError, never> =>
  Effect.gen(function* () {
    const network: Network = lucid.config().network ?? "Preprod";
    const utxos = yield* getUtxosAt(lucid, savingsVaultAddress(network));
    const loans: FundLoan[] = [];
    for (const raw of utxos) {
      const utxo = patchInlineDatum(raw);
      const key = Object.keys(utxo.assets).find(
        (k) => k.startsWith(savingsPolicyId) && k.length === 56 + 64,
      );
      if (!key) continue;
      const parsed = yield* parseSafeDatum(utxo.datum, SavingsDatumSchema).pipe(
        Effect.map((d) => d as unknown as SavingsDatum),
        Effect.orElseSucceed(() => null),
      );
      if (!parsed || typeof parsed === "string" || !("LoanAccount" in parsed))
        continue;
      if (parsed.LoanAccount.fund_id !== fundTokenName) continue;
      loans.push({
        loanTokenName: key.slice(56),
        loan: parsed.LoanAccount,
        utxo,
      });
    }
    return loans;
  });

export const getFundLoans = (lucid: LucidEvolution, fundTokenName: string) =>
  Effect.runPromise(getFundLoansProgram(lucid, fundTokenName));
