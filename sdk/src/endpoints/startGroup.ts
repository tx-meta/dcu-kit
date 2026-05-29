import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  GroupDatum,
  GroupSpendRedeemer,
} from "../core/types.js";
import { groupValidator, groupPolicyId } from "../core/validators/constants.js";
import {
  getScriptAddress,
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
 * Creates an unsigned transaction for starting a DCU Group.
 *
 * **Functionality:**
 * - Seals membership: no new members can join after startGroup.
 * - Sets num_rounds = member_count (fixing the rotation schedule).
 * - Sets start_time = tx validity lower bound (anchoring the schedule).
 * - Requires at least 2 members (enforced by the on-chain validator).
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - StartGroup Configuration.
 * @returns Effect yielding a TxSignBuilder ready for signing.
 */
export type StartGroupConfig = {
  groupTokenSuffix: string;
  currentTime?: bigint; // POSIX ms — emulator.now() for emulator, omit for live
};

export const unsignedStartGroupTxProgram = (
  lucid: LucidEvolution,
  config: StartGroupConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupTokenSuffix } = config;

    const groupRefUnit =
      groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUserUnit =
      groupPolicyId! + assetNameLabels.prefix222 + groupTokenSuffix;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const adminUtxoRaw = yield* resolveUtxoByUnit(lucid, groupUserUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const adminUtxo = patchInlineDatum(adminUtxoRaw);

    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);
    const groupDatum = groupCip68.groupDatum;

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

    // validFrom = start_time; Aiken reads it via get_lower_bound(tx)
    const rawNow =
      config.currentTime !== undefined
        ? config.currentTime
        : BigInt(Date.now()) - 120_000n;
    const now =
      config.currentTime !== undefined ? rawNow : rawNow - (rawNow % 1000n);

    const updatedGroupDatum: GroupDatum = {
      ...groupDatum,
      is_started: true,
      num_rounds: groupDatum.member_count,
      start_time: now,
    };

    const groupAddress = yield* getScriptAddress(
      lucid,
      groupValidator.spendGroup,
    );
    const adminAddress = yield* getWalletAddress(lucid);

    // RedeemerBuilder resolves admin_input_index and group_input_index from sorted tx.inputs
    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (indices: bigint[]) =>
        Data.to(
          {
            StartGroup: {
              group_ref_token_name: groupRefName,
              admin_input_index: indices[0], // admin (222) token UTxO
              group_input_index: indices[1], // group ref UTxO (self-reference at entry point)
              group_output_index: 0n,
            },
          },
          GroupSpendRedeemer,
        ),
      inputs: [adminUtxo, groupUtxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([adminUtxo])
      .collectFrom([groupUtxo], redeemer)
      .pay.ToContract(
        groupAddress,
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
      .pay.ToAddress(adminAddress, { [groupUserUnit]: 1n })
      .attach.SpendingValidator(groupValidator.spendGroup)
      .addSigner(adminAddress)
      .validFrom(Number(now))
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "startGroup",
              error: String(e),
            }),
        ),
      );

    return tx;
  });
