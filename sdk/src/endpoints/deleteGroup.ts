import {
  LucidEvolution,
  Data,
  TxSignBuilder,
  RedeemerBuilder,
  Assets,
  Constr,
  Script,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  DcuError,
  TransactionBuildError,
  UtxoNotFoundError,
} from "../core/errors.js";
import {
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
} from "../core/utils/index.js";
import { Protocol } from "../core/validators/constants.js";

/**
 * Creates an unsigned transaction for deleting a DCU Group.
 *
 * **Functionality:**
 * - Burns both group tokens (Reference 100 + Admin Auth 222).
 * - Returns all ADA locked in the group UTxO (including creator_bond) to the
 *   admin wallet as transaction change.
 *
 * **Constraints:**
 * - Group must be deactivated first (is_active == false via updateGroup).
 * - Group member_count must be 0 — all members must have exited.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Delete Group Configuration.
 * @returns Effect yielding TxSignBuilder.
 */
export type DeleteGroupConfig = {
  groupTokenSuffix: string;
  /** Native-script witness when the admin 222 token is at a multisig address. */
  adminScript?: Script;
  /** Key hashes to declare as required signers (co-signers of adminScript). */
  adminSignerKeyHashes?: string[];
};

export const unsignedDeleteGroupTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: DeleteGroupConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupValidator, groupPolicyId } = protocol;
    const { groupTokenSuffix } = config;

    const groupRefUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    const adminUnit =
      groupPolicyId + assetNameLabels.prefix222 + groupTokenSuffix;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const adminUtxo = yield* resolveUtxoByUnit(lucid, adminUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);

    const groupRefAsset = Object.keys(groupUtxo.assets).find((k) =>
      k.startsWith(groupPolicyId),
    );
    if (!groupRefAsset)
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: "GroupReference (100)",
          address: groupUtxo.address,
        }),
      );
    const groupRefName = groupRefAsset.slice(groupPolicyId.length);

    // Burn both tokens (ref + user, qty -1 each).
    // BurnGroup is variant index 1 in GroupMintRedeemer — no fields, Constr(1, []).
    const burnAssets: Assets = {
      [groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix]: -1n,
      [groupPolicyId + assetNameLabels.prefix222 + groupTokenSuffix]: -1n,
    };
    const burnRedeemer = Data.to(new Constr(1, []));

    // CloseGroup is variant index 1 in GroupSpendRedeemer.
    // Fields: [group_ref_token_name, admin_input_index, group_input_index]
    // (group_output_index removed — burn produces no group UTxO)
    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          new Constr(1, [groupRefName, inputIndices[0], inputIndices[1]]),
        ),
      inputs: [adminUtxo, groupUtxo],
    };

    const { adminScript, adminSignerKeyHashes } = config;

    const baseTx = lucid
      .newTx()
      .collectFrom([adminUtxo])
      .collectFrom([groupUtxo], spendRedeemer)
      .mintAssets(burnAssets, burnRedeemer)
      .attach.MintingPolicy(groupValidator.mintGroup)
      .attach.SpendingValidator(groupValidator.spendGroup);

    const withAdminWitness = adminScript
      ? baseTx.attach.SpendingValidator(adminScript)
      : baseTx;

    const withSigners = (adminSignerKeyHashes ?? []).reduce(
      (t, kh) => t.addSignerKey(kh),
      withAdminWitness,
    );

    const tx = yield* withSigners
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "deleteGroup",
              error: String(e),
            }),
        ),
      );
    return tx;
  });
