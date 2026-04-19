import { LucidEvolution, Data, UTxO, TxSignBuilder, RedeemerBuilder, Assets } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum, GroupSpendRedeemer } from "../core/types.js";
import { DcuError, TransactionBuildError, UtxoNotFoundError } from "../core/errors.js";
import { getScriptAddress } from "../core/utils/index.js";
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
    groupUtxo: UTxO;
    currentDatum: GroupDatum;
    adminUtxo: UTxO;
};

export const unsignedDeleteGroupTxProgram = (
  lucid: LucidEvolution,
  config: DeleteGroupConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
      const { groupUtxo, currentDatum, adminUtxo } = config;
      const address = yield* getScriptAddress(lucid, groupValidator.spendGroup);

      const deactivatedDatum: GroupDatum = {
          ...currentDatum,
          is_active: false
      };

      const groupRefAsset = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicyId!));
      if (!groupRefAsset) return yield* Effect.fail(new UtxoNotFoundError({ tokenName: "GroupReference (100)", address: groupUtxo.address }));
      const groupRefName = groupRefAsset.slice(groupPolicyId!.length);

      const groupAssets: Assets = { ...groupUtxo.assets };

      const redeemer: RedeemerBuilder = {
          kind: "selected",
          makeRedeemer: (inputIndices: bigint[]) => {
              return Data.to({
                  RemoveGroup: {
                      group_ref_token_name: groupRefName,
                      group_input_index: inputIndices[0],
                      admin_input_index: inputIndices[1],
                      group_output_index: 0n
                  }
              }, GroupSpendRedeemer);
          },
          inputs: [groupUtxo, adminUtxo]
      };

      const tx = yield* lucid
        .newTx()
        .collectFrom([groupUtxo], redeemer)
        .collectFrom([adminUtxo])
        .pay.ToContract(address, { kind: "inline", value: Data.to(deactivatedDatum, GroupDatum) }, groupAssets)
        .attach.SpendingValidator(groupValidator.spendGroup)
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "deleteGroup", error: String(e) })));
      return tx;
  });
