import { Constr, LucidEvolution, Data, UTxO, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum, GroupSpendRedeemer } from "../core/types.js";
import { DcuValidators } from "../core/validators/context.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { tryBuildTx } from "../core/utils.js";

/**
 * Creates an unsigned transaction for Updating Group Configuration.
 * 
 * **Functionality:**
 * - Updates Group Datum (e.g., Fees, Inactive State).
 * - Requires authentication via `GroupAdmin` token.
 * 
 * **Constraints:**
 * - **Member Count Check:** Critical changes (Fees, Intervals) allowed **ONLY** if `member_count == 0` (Enforced by Validator).
 * 
 * @param lucid - Lucid instance.
 * @param groupUtxo - Group UTxO to update.
 * @param updatedDatum - New Group Configuration (Datum).
 * @param adminUtxo - Admin Auth UTxO.
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedUpdateGroupTxProgram = (
  lucid: LucidEvolution,
  groupUtxo: UTxO,
  updatedDatum: GroupDatum,
  adminUtxo: UTxO,
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
      const groupScripts = scripts.group;
      const address = groupScripts.spend.address;

      const redeemer = Data.to({
          UpdateGroup: {
              group_ref_token_name: fromText("GroupReference"),
              admin_input_index: 0n,
              group_input_index: 0n,
              group_output_index: 0n
          }
      }, GroupSpendRedeemer);

      const tx = yield* tryBuildTx("updateGroup", () => lucid
        .newTx()
        .collectFrom([groupUtxo], redeemer)
        .collectFrom([adminUtxo])
        .attach.SpendingValidator(groupScripts.spend.script)
        .pay.ToContract(
            address,
            { kind: "inline", value: Data.to(updatedDatum, GroupDatum) },
            groupUtxo.assets
        )
        .complete()
      );

      return tx;
  });
