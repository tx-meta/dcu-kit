import {
  LucidEvolution,
  Data,
  TxSignBuilder,
  RedeemerBuilder,
  Assets,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupCip68Datum, GroupCip68DatumSchema, GroupDatum, GroupSpendRedeemer } from "../core/types.js";
import {
  DcuError,
  TransactionBuildError,
  UtxoNotFoundError,
} from "../core/errors.js";
import {
  getScriptAddress,
  parseGroupCip68Datum,
  buildGroupCip68Datum,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
} from "../core/utils/index.js";
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
 *   { groupTokenSuffix, updatedDatum }
 * );
 * ```
 */
export type UpdateGroupConfig = {
  groupTokenSuffix: string;
  updatedDatum: GroupDatum;
};

export const unsignedUpdateGroupTxProgram = (
  lucid: LucidEvolution,
  config: UpdateGroupConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupTokenSuffix, updatedDatum } = config;

    const groupRefUnit =
      groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
    const adminUnit =
      groupPolicyId! + assetNameLabels.prefix222 + groupTokenSuffix;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const adminUtxo = yield* resolveUtxoByUnit(lucid, adminUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const address = yield* getScriptAddress(lucid, groupValidator.spendGroup);

    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);

    const groupRefAsset = Object.keys(groupUtxo.assets).find((k) =>
      k.startsWith(groupPolicyId!),
    );
    if (!groupRefAsset)
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: "GroupReference (100)",
          address: groupUtxo.address,
        }),
      );
    const groupRefName = groupRefAsset.slice(groupPolicyId!.length);

    const groupAssets: Assets = { ...groupUtxo.assets };

    // Mirror payment-subscription's service pattern: wallet UTxO first in inputs array,
    // script UTxO second. Use Constr directly (positionally explicit) to match the
    // proven reference implementation and avoid any schema field-order ambiguity.
    // UpdateGroup is variant index 0 in GroupSpendRedeemer.
    // Field order in Constr matches Aiken definition: [group_ref_token_name, admin_input_index, group_input_index, group_output_index]
    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) => {
        // ✅ Safe: Typed with your exact schema!
        return Data.to<GroupSpendRedeemer>(
          {
            UpdateGroup: {
              group_ref_token_name: groupRefName,
              admin_input_index: inputIndices[0],
              group_input_index: inputIndices[1],
              group_output_index: 0n,
            },
          },
          GroupSpendRedeemer,
        );
      },
      inputs: [adminUtxo, groupUtxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([adminUtxo])
      .collectFrom([groupUtxo], redeemer)
      .pay.ToContract(
        address,
        { kind: "inline", value: buildGroupCip68Datum(groupCip68.metadata, groupCip68.version, updatedDatum) },
        groupAssets,
      )
      .attach.SpendingValidator(groupValidator.spendGroup)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "updateGroup",
              error: String(e),
            }),
        ),
      );
    return tx;
  });
