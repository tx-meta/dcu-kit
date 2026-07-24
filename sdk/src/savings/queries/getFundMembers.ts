import { LucidEvolution, Network, UTxO } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { LucidError } from "../../core/errors.js";
import {
  getUtxosAt,
  parseSafeDatum,
  patchInlineDatum,
} from "../../core/utils/index.js";
import { assetNameLabels } from "../../core/utils/assets.js";
import {
  MemberAccountFields,
  SavingsDatum,
  SavingsDatumSchema,
} from "../types.js";
import { savingsVaultAddress } from "../utils.js";
import { savingsPolicyId } from "../validators.js";

export type FundMember = {
  memberTokenSuffix: string;
  account: MemberAccountFields;
  refUtxo: UTxO;
};

/** Lists all live member accounts of a fund (scan of the vault address). */
export const getFundMembersProgram = (
  lucid: LucidEvolution,
  fundTokenName: string,
): Effect.Effect<FundMember[], LucidError, never> =>
  Effect.gen(function* () {
    const network: Network = lucid.config().network ?? "Preprod";
    const utxos = yield* getUtxosAt(lucid, savingsVaultAddress(network));
    const refPrefix = savingsPolicyId + assetNameLabels.prefix100;
    const members: FundMember[] = [];
    for (const raw of utxos) {
      const utxo = patchInlineDatum(raw);
      const refKey = Object.keys(utxo.assets).find((k) =>
        k.startsWith(refPrefix),
      );
      if (!refKey) continue;
      const parsed = yield* parseSafeDatum(utxo.datum, SavingsDatumSchema).pipe(
        Effect.map((d) => d as unknown as SavingsDatum),
        Effect.orElseSucceed(() => null),
      );
      if (!parsed || typeof parsed === "string" || !("MemberAccount" in parsed))
        continue;
      if (parsed.MemberAccount.fund_id !== fundTokenName) continue;
      members.push({
        memberTokenSuffix: refKey.slice(refPrefix.length),
        account: parsed.MemberAccount,
        refUtxo: utxo,
      });
    }
    return members;
  });

export const getFundMembers = (lucid: LucidEvolution, fundTokenName: string) =>
  Effect.runPromise(getFundMembersProgram(lucid, fundTokenName));
