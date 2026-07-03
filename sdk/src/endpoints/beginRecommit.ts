import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { AdminAuthConfig, applyAdminWitness } from "../multisig/index.js";
import { effectiveScriptRefs } from "../core/scripts.js";
import { GroupDatum, GroupSpendRedeemer } from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
import {
  parseGroupCip68Datum,
  buildGroupCip68Datum,
  getWalletAddress,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
} from "../core/utils/index.js";
import {
  DcuError,
  TransactionBuildError,
  UtxoNotFoundError,
} from "../core/errors.js";

/**
 * Creates an unsigned transaction opening a group's recommit window.
 *
 * **Functionality:**
 * - Admin-only, and only when every remaining member is clean AND the rotation is at
 *   a completed lap OR provably halted at a vacant slot (a member exited mid-cycle).
 * - During the window: distribution is blocked, joining re-opens, and every member's
 *   exit is FREE — leaving is simply not staying. Staying costs nothing (opt-out).
 * - After `recommit_window` elapses, `startGroup` re-seals: fresh first-come
 *   first-served slots by registry order and a new rotation era. Rounds resume on the
 *   same monotonic counter.
 *
 * @param lucid - Lucid instance with the admin wallet selected.
 * @param config - BeginRecommit Configuration.
 * @returns Effect yielding a TxSignBuilder ready for signing.
 */
export type BeginRecommitConfig = {
  groupTokenSuffix: string;
  currentTime?: bigint; // POSIX ms — emulator.now() for emulator, omit for live
  scriptRefs?: {
    treasury?: UTxO;
    group?: UTxO;
  };
} & AdminAuthConfig;

export const unsignedBeginRecommitTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: BeginRecommitConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupValidator, groupPolicyId } = protocol;
    const { groupTokenSuffix } = config;

    const groupRefUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUserUnit =
      groupPolicyId + assetNameLabels.prefix222 + groupTokenSuffix;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const adminUtxoRaw = yield* resolveUtxoByUnit(lucid, groupUserUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const adminUtxo = patchInlineDatum(adminUtxoRaw);

    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);
    const groupDatum = groupCip68.groupDatum;

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

    // validFrom = window-open time; the validator records it in start_time
    const rawNow =
      config.currentTime !== undefined
        ? config.currentTime
        : BigInt(Date.now()) - 120_000n;
    const now =
      config.currentTime !== undefined ? rawNow : rawNow - (rawNow % 1000n);

    const updatedGroupDatum: GroupDatum = {
      ...groupDatum,
      is_started: false,
      // While !is_started, start_time carries the window-open time — the re-sealing
      // startGroup enforces now >= start_time + recommit_window against it.
      start_time: now,
      member_slots: [],
    };
    const adminAddress = yield* getWalletAddress(lucid);

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (indices: bigint[]) =>
        Data.to(
          {
            BeginRecommit: {
              group_ref_token_name: groupRefName,
              admin_input_index: indices[0],
              group_input_index: indices[1],
              group_output_index: 0n,
            },
          },
          GroupSpendRedeemer,
        ),
      inputs: [adminUtxo, groupUtxo],
    };

    const adminTokenReturnAddress = config.adminScript
      ? config.adminReturnAddress ?? adminUtxo.address
      : adminAddress;
    const adminTokenReturnAssets = config.adminScript
      ? adminUtxo.assets
      : { [groupUserUnit]: 1n };

    const baseTx = lucid
      .newTx()
      .collectFrom([adminUtxo])
      .collectFrom([groupUtxo], redeemer)
      .pay.ToContract(
        groupUtxo.address,
        {
          kind: "inline",
          value: buildGroupCip68Datum(
            groupCip68.metadata,
            groupCip68.version,
            updatedGroupDatum,
          ),
        },
        groupUtxo.assets,
      )
      .pay.ToAddress(adminTokenReturnAddress, adminTokenReturnAssets)
      .addSigner(adminAddress)
      .validFrom(Number(now));

    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const withValidators =
      scriptRefs.treasury || scriptRefs.group
        ? baseTx.readFrom(
            [scriptRefs.treasury, scriptRefs.group].filter(Boolean) as UTxO[],
          )
        : baseTx.attach.SpendingValidator(groupValidator.spendGroup);

    const withSigners = applyAdminWitness(withValidators, config);

    const tx = yield* withSigners
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "beginRecommit",
              error: String(e),
            }),
        ),
      );

    return tx;
  });
