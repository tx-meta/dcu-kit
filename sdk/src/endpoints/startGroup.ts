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
  // Reference script UTxOs (from deploy-scripts). When provided, the validator
  // script bytes are resolved from the on-chain UTxO rather than included inline,
  // keeping the transaction well under the 16KB Cardano size limit.
  scriptRefs?: {
    treasury?: UTxO; // UTxO with scriptRef for treasury validator
    group?: UTxO; // UTxO with scriptRef for group validator
  };
} & AdminAuthConfig;

export const unsignedStartGroupTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: StartGroupConfig,
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
      // Seal the active set = full membership at start.
      active_member_count: groupDatum.member_count,
      start_time: now,
    };
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

    // Use reference scripts when provided — avoids including ~12KB of script bytes
    // inline, keeping the tx under Cardano's 16,384-byte size limit.
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
              operation: "startGroup",
              error: String(e),
            }),
        ),
      );

    return tx;
  });
