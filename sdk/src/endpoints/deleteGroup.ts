import { LucidEvolution, Data, TxSignBuilder, RedeemerBuilder, Assets, Constr } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum } from "../core/types.js";
import { DcuError, TransactionBuildError, UtxoNotFoundError } from "../core/errors.js";
import { getScriptAddress, patchInlineDatum, parseSafeDatum, assetNameLabels, resolveUtxoByUnit } from "../core/utils/index.js";
import { groupValidator, groupPolicyId } from "../core/validators/constants.js";

/**
 * Creates an unsigned transaction for deleting (deactivating) a DCU Group.
 * 
 * **Functionality:**
 * - Deactivates the Group by setting `is_active` to false.
 * - This is a "soft delete" as the UTxO remains but the group is non-functional.
 * 
 * **Constraints:**
 * - Group can only be deleted if `member_count` is 0.
 * 
 * @param lucid - Lucid instance with wallet selected.
 * @param groupUtxo - The Group Reference UTxO.
 * @param currentDatum - The current Group Datum.
 * @param adminUtxo - The Admin Auth UTxO.
 * @returns Effect yielding TxSignBuilder.
 * 
 * @example
 * ```typescript
 * const program = unsignedDeleteGroupTxProgram(lucid, 
 *   groupUtxo, currentDatum, adminUtxo
 * );
 * ```
 */

export type DeleteGroupConfig = {
    groupTokenSuffix: string;
};

export const unsignedDeleteGroupTxProgram = (
  lucid: LucidEvolution,
  config: DeleteGroupConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
      const { groupTokenSuffix } = config;

      const groupRefUnit = groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
      const adminUnit    = groupPolicyId! + assetNameLabels.prefix222 + groupTokenSuffix;

      const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
      const adminUtxo    = yield* resolveUtxoByUnit(lucid, adminUnit);
      const groupUtxo    = patchInlineDatum(groupUtxoRaw);
      const address      = yield* getScriptAddress(lucid, groupValidator.spendGroup);

      const currentDatum = yield* parseSafeDatum(groupUtxo.datum, GroupDatum);
      const deactivatedDatum: GroupDatum = {
          ...currentDatum,
          is_active: false
      };

      const groupRefAsset = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicyId!));
      if (!groupRefAsset) return yield* Effect.fail(new UtxoNotFoundError({ tokenName: "GroupReference (100)", address: groupUtxo.address }));
      const groupRefName = groupRefAsset.slice(groupPolicyId!.length);

      const groupAssets: Assets = { ...groupUtxo.assets };

      // Mirror payment-subscription's service pattern: wallet UTxO first in inputs array,
      // script UTxO second. Use Constr directly (positionally explicit) to match the
      // proven reference implementation and avoid any schema field-order ambiguity.
      // RemoveGroup is variant index 1 in GroupSpendRedeemer.
      // Field order in Constr matches Aiken definition: [group_ref_token_name, admin_input_index, group_input_index, group_output_index]
      const redeemer: RedeemerBuilder = {
          kind: "selected",
          makeRedeemer: (inputIndices: bigint[]) => {
              return Data.to(new Constr(1, [groupRefName, inputIndices[0], inputIndices[1], 0n]));
          },
          inputs: [adminUtxo, groupUtxo]
      };

      const tx = yield* lucid
        .newTx()
        .collectFrom([adminUtxo])
        .collectFrom([groupUtxo], redeemer)
        .pay.ToContract(address, { kind: "inline", value: Data.to(deactivatedDatum, GroupDatum) }, groupAssets)
        .attach.SpendingValidator(groupValidator.spendGroup)
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "deleteGroup", error: String(e) })));
      return tx;
  });
