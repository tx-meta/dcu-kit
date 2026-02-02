import { Constr, LucidEvolution, Data, UTxO, fromText, TxSignBuilder, RedeemerBuilder } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum, GroupSpendRedeemer } from "../core/types.js";
import { DcuValidators } from "../core/validators/context.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { tryBuildTx } from "../core/utils/index.js";

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
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
 * 
 * @example
 * ```typescript
 * const program = unsignedDeleteGroupTxProgram(lucid, 
 *   groupUtxo, currentDatum, adminUtxo, scripts
 * );
 * ```
 */
export const unsignedDeleteGroupTxProgram = (
  lucid: LucidEvolution,
  groupUtxo: UTxO,
  currentDatum: GroupDatum, // Needed to preserve other fields but set is_active = false
  adminUtxo: UTxO,
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
      const groupScripts = scripts.group;
      const address = groupScripts.spend.address;

      // Construct Updated Datum (Soft Delete / Deactivate)
      const deactivatedDatum: GroupDatum = {
          ...currentDatum,
          is_active: false
      };

      const redeemer: RedeemerBuilder = {
          kind: "selected",
          makeRedeemer: (inputIndices: bigint[]) => {
               // [groupUtxo, adminUtxo] -> [groupIndex, adminIndex]
              return Data.to({
                  RemoveGroup: {
                      group_ref_token_name: fromText("GroupReference"),
                      group_input_index: inputIndices[0],
                      admin_input_index: inputIndices[1],
                      group_output_index: 0n 
                  }
              }, GroupSpendRedeemer);
          },
          inputs: [groupUtxo, adminUtxo]
      };

      const tx = yield* tryBuildTx("deleteGroup", () => lucid
        .newTx()
        .collectFrom([groupUtxo], redeemer)
        .collectFrom([adminUtxo])
        .attach.SpendingValidator(groupScripts.spend.script)
        .pay.ToContract(
            address,
            { kind: "inline", value: Data.to(deactivatedDatum, GroupDatum) },
            groupUtxo.assets
        )
        .complete()
      );

      return tx;
  });
