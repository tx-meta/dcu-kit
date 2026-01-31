import { Constr, LucidEvolution, Data, UTxO, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum, GroupSpendRedeemer } from "../core/types.js";
import { DcuValidators } from "../core/validators/context.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { tryBuildTx } from "../core/utils.js";

/**
 * Creates an unsigned transaction for Deleting (Deactivating) a Group.
 * 
 * **Functionality:**
 * - Uses `RemoveGroup` redeemer.
 * - **Current Logic:** Updates Group Datum to `is_active: false` (Soft Delete).
 * - **Constraint:** `member_count` must be 0 (Enforced by Validator).
 * 
 * @param lucid - Lucid instance.
 * @param groupUtxo - Group UTxO to update.
 * @param currentDatum - Current Group Datum (used to construct deactivated state).
 * @param adminUtxo - Admin Auth UTxO.
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
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

      const redeemer = Data.to({
          RemoveGroup: {
              group_ref_token_name: fromText("GroupReference"),
              admin_input_index: 0n,
              group_input_index: 0n,
              group_output_index: 0n
          }
      }, GroupSpendRedeemer);

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
