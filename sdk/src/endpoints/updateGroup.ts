import { Constr, LucidEvolution, Data, UTxO, fromText, TxSignBuilder, RedeemerBuilder } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum, GroupSpendRedeemer } from "../core/types.js";
import { DcuValidators } from "../core/validators/context.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { tryBuildTx } from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for updating a DCU Group's configuration.
 * 
 * **Functionality:**
 * - Updates the Group Datum (e.g. Fees, Intervals, Inactive State).
 * - Requires the Admin Auth NFT for authorization.
 * 
 * **Constraints:**
 * - Critical changes (Fees, Intervals) are only allowed if `member_count` is 0.
 * 
 * @param lucid - Lucid instance with wallet selected.
 * @param groupUtxo - The current Group Reference UTxO.
 * @param updatedDatum - The new Group Configuration.
 * @param adminUtxo - The Admin Auth UTxO.
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
 * 
 * @example
 * ```typescript
 * const program = unsignedUpdateGroupTxProgram(lucid, 
 *   groupUtxo, updatedDatum, adminUtxo, scripts
 * );
 * ```
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

      const redeemer: RedeemerBuilder = {
          kind: "selected",
          makeRedeemer: (inputIndices: bigint[]) => {
              // inputIndices correspond to the order of inputs in 'inputs' array below
              // [groupUtxo, adminUtxo] -> [groupIndex, adminIndex]
              return Data.to({
                  UpdateGroup: {
                      group_ref_token_name: fromText("GroupReference"),
                      group_input_index: inputIndices[0],
                      admin_input_index: inputIndices[1],
                      group_output_index: 0n // Output index is usually 0 if it's the first contract output
                  }
              }, GroupSpendRedeemer);
          },
          inputs: [groupUtxo, adminUtxo]
      };

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
