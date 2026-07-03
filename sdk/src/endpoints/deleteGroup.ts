import {
  LucidEvolution,
  Data,
  TxSignBuilder,
  RedeemerBuilder,
  Assets,
  Constr,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { AdminAuthConfig, applyAdminWitness } from "../multisig/index.js";
import { effectiveScriptRefs } from "../core/scripts.js";
import {
  DcuError,
  TransactionBuildError,
  UtxoNotFoundError,
} from "../core/errors.js";
import {
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  reserveTokenName,
} from "../core/utils/index.js";
import { TreasuryRedeemer } from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";

/**
 * Creates an unsigned transaction for deleting a DCU Group.
 *
 * **Functionality:**
 * - Burns both group tokens (Reference 100 + Admin Auth 222).
 * - Closes the group's mutual reserve in the same tx (ReserveClose): the reserve
 *   token burns with the group and any residue in the pot returns to the admin
 *   wallet as transaction change.
 * - Returns all ADA locked in the group UTxO (including creator_bond) to the
 *   admin wallet as transaction change.
 *
 * **Constraints:**
 * - Group must be deactivated first (is_active == false via updateGroup).
 * - Group member_count must be 0 — all members must have exited (each wind-down
 *   exit may take its equal share of the reserve on the way out).
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Delete Group Configuration.
 * @returns Effect yielding TxSignBuilder.
 */
export type DeleteGroupConfig = {
  groupTokenSuffix: string;
  /**
   * Deployed reference scripts. Deletion now also runs the treasury validator
   * (ReserveClose); the two attached inline exceed the tx size limit.
   */
  scriptRefs?: {
    treasury?: UTxO;
    group?: UTxO;
  };
} & AdminAuthConfig;

export const unsignedDeleteGroupTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: DeleteGroupConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupValidator, groupPolicyId, treasuryValidator, treasuryPolicyId, settingsUnit } =
      protocol;
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

    // The group's reserve — closed (token burned, residue to change) in this tx.
    // The treasury validator reads the trusted group policy from the settings UTxO.
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const reserveUnit = treasuryPolicyId + reserveTokenName(groupRefName);
    const reserveUtxoRaw = yield* resolveUtxoByUnit(lucid, reserveUnit);
    const reserveUtxo = patchInlineDatum(reserveUtxoRaw);

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

    // Reserve spend + burn: ReserveClose pins the deletion shape on-chain.
    const reserveSpendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { ReserveClose: { group_input_index: inputIndices[0] } },
          TreasuryRedeemer,
        ),
      inputs: [groupUtxo],
    };
    const reserveBurnAssets: Assets = {
      [reserveUnit]: -1n,
    };
    const reserveBurnRedeemer = Data.to(
      { ReserveClose: { group_input_index: 0n } },
      TreasuryRedeemer,
    );

    const baseTx = lucid
      .newTx()
      .collectFrom([adminUtxo])
      .collectFrom([groupUtxo], spendRedeemer)
      .collectFrom([reserveUtxo], reserveSpendRedeemer)
      .mintAssets(burnAssets, burnRedeemer)
      .mintAssets(reserveBurnAssets, reserveBurnRedeemer)
      .readFrom([settingsUtxo]);

    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const withValidators =
      scriptRefs.treasury || scriptRefs.group
        ? baseTx.readFrom(
            [scriptRefs.treasury, scriptRefs.group].filter(Boolean) as UTxO[],
          )
        : baseTx.attach
            .MintingPolicy(groupValidator.mintGroup)
            .attach.SpendingValidator(groupValidator.spendGroup)
            .attach.MintingPolicy(treasuryValidator.mintTreasury)
            .attach.SpendingValidator(treasuryValidator.spendTreasury);

    const withSigners = applyAdminWitness(withValidators, config);

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
