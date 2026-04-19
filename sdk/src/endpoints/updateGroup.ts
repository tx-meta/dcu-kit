import { LucidEvolution, Data, UTxO, TxSignBuilder, RedeemerBuilder, Assets } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum, GroupSpendRedeemer } from "../core/types.js";
import { DcuError, TransactionBuildError, UtxoNotFoundError } from "../core/errors.js";
import { getScriptAddress } from "../core/utils/index.js";
import { groupValidator, groupPolicyId } from "../core/validators/constants.js";

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
 * @param config - Update Configuration.
 * @returns Effect yielding TxSignBuilder.
 * 
 * @example
 * ```typescript
 * const program = unsignedUpdateGroupTxProgram(lucid, 
 *   { groupUtxo, updatedDatum, adminUtxo }
 * );
 * ```
 */
export type UpdateGroupConfig = {
    groupUtxo: UTxO;
    updatedDatum: GroupDatum;
    adminUtxo: UTxO;
};

export const unsignedUpdateGroupTxProgram = (
  lucid: LucidEvolution,
  config: UpdateGroupConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
      const { groupUtxo, updatedDatum, adminUtxo } = config;
      const address = yield* getScriptAddress(lucid, groupValidator.spendGroup);

      const groupRefAsset = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicyId!));
      if (!groupRefAsset) return yield* Effect.fail(new UtxoNotFoundError({ tokenName: "GroupReference (100)", address: groupUtxo.address }));
      const groupRefName = groupRefAsset.slice(groupPolicyId!.length);

      const groupAssets: Assets = { ...groupUtxo.assets };

      const redeemer: RedeemerBuilder = {
          kind: "selected",
          makeRedeemer: (inputIndices: bigint[]) => {
              return Data.to({
                  UpdateGroup: {
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
        .pay.ToContract(address, { kind: "inline", value: Data.to(updatedDatum, GroupDatum) }, groupAssets)
        .attach.SpendingValidator(groupValidator.spendGroup)
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "updateGroup", error: String(e) })));
      return tx;
  });
