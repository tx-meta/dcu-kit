
import {
    Data,
    LucidEvolution,
    UTxO,
    TxSignBuilder,
    RedeemerBuilder,
    fromText
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
    GroupDatum,
    GroupSpendRedeemer,
    TreasuryDatum,
    TreasuryDatumSchema,
    TreasuryRedeemer
} from "../core/types.js";
import { treasuryValidator, treasuryPolicyId, groupValidator, groupPolicyId } from "../core/validators/constants.js";
import { DcuError, InvalidDatumError, TransactionBuildError } from "../core/errors.js";
import { getScriptAddress, getWalletAddress, parseSafeDatum } from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for exiting a Group.
 *
 * **Functionality:**
 * - Spends the Group UTxO to decrement the member count.
 * - Handles both early and mature exits from a Group.
 * - Early Exit: Transition to Penalty State (fee deduction).
 * - Mature Exit: Burn Membership token and receive full refund.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Exit Group Configuration.
 * @returns Effect yielding TxSignBuilder.
 *
 * @example
 * ```typescript
 * const program = unsignedExitGroupTxProgram(lucid,
 *   { groupUtxo, accountUtxo, treasuryUtxo }
 * );
 * ```
 */
export type ExitGroupConfig = {
    groupUtxo: UTxO;
    accountUtxo: UTxO;
    treasuryUtxo: UTxO;
};

export const unsignedExitGroupTxProgram = (
  lucid: LucidEvolution,
  config: ExitGroupConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupUtxo, accountUtxo, treasuryUtxo } = config;
    const treasuryDatum = (yield* parseSafeDatum(treasuryUtxo.datum, TreasuryDatumSchema)) as unknown as TreasuryDatum;
    if (!('TreasuryState' in treasuryDatum)) return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Expected TreasuryState" }));

    const memberRefName = treasuryDatum.TreasuryState.member_reference_tokenname;
    const policyId = treasuryPolicyId!;

    const groupDatum = yield* parseSafeDatum(groupUtxo.datum, GroupDatum);

    // Derive group reference token name from the Group UTxO's assets
    const groupRefAssetEntry = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicyId!));
    const groupRefName = groupRefAssetEntry
        ? groupRefAssetEntry.slice(groupPolicyId!.length)
        : fromText("GroupReference");

    const now = BigInt(Date.now());
    const maturityTime = groupDatum.start_time + (groupDatum.num_intervals * groupDatum.interval_length);
    const isEarlyExit = groupDatum.is_active && (now < maturityTime);

    // Updated Group datum: decrement member count on exit
    const updatedGroupDatum: GroupDatum = {
        ...groupDatum,
        member_count: groupDatum.member_count - 1n
    };

    // Group validator redeemer: UpdateGroup (accountUtxo serves as member proof)
    const groupRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            UpdateGroup: {
                group_ref_token_name: groupRefName,
                group_input_index: inputIndices[0],
                admin_input_index: inputIndices[1],
                group_output_index: 0n
            }
        }, GroupSpendRedeemer),
        inputs: [groupUtxo, accountUtxo]
    };

    // Treasury validator redeemer: ExitGroup
    // Group UTxO is now a spending input, so group_ref_input_index is dynamic.
    // Output layout: [0] Group UTxO, [1] Penalty (early exit only)
    const treasuryRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            ExitGroup: {
                group_ref_input_index: inputIndices[0],
                member_input_index: inputIndices[1],
                treasury_input_index: inputIndices[2],
                penalty_output_index: isEarlyExit ? 1n : 0n
            }
        }, TreasuryRedeemer),
        inputs: [groupUtxo, accountUtxo, treasuryUtxo]
    };

    const address = yield* getWalletAddress(lucid);
    const groupAddress = yield* getScriptAddress(lucid, groupValidator.spendGroup);
    const treasuryAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);

    const txBuilder = lucid.newTx()
        .collectFrom([groupUtxo], groupRedeemer)
        .collectFrom([accountUtxo])
        .collectFrom([treasuryUtxo], treasuryRedeemer)
        .attach.MintingPolicy(treasuryValidator.mintTreasury)
        .attach.SpendingValidator(treasuryValidator.spendTreasury)
        .attach.SpendingValidator(groupValidator.spendGroup)
        .addSigner(address)
        // Output 0: Return Group UTxO with decremented member_count
        .pay.ToContract(
            groupAddress,
            { kind: "inline", value: Data.to(updatedGroupDatum, GroupDatum) },
            groupUtxo.assets
        );

    if (isEarlyExit) {
        const penaltyDatum: TreasuryDatum = {
            PenaltyState: {
                group_reference_tokenname: treasuryDatum.TreasuryState.group_reference_tokenname,
                member_reference_tokenname: treasuryDatum.TreasuryState.member_reference_tokenname
            }
        };
        // Output 1: Transition to Penalty State (Keep Token)
        txBuilder.pay.ToContract(
            treasuryAddress,
            { kind: "inline", value: Data.to(penaltyDatum, TreasuryDatum) },
            {
                lovelace: 2_000_000n + groupDatum.penalty_fee,
                [policyId + memberRefName]: 1n
            }
        );
    } else {
        // Mature Exit: Burn Token
        txBuilder.mintAssets(
            { [policyId + memberRefName]: -1n },
            treasuryRedeemer
        );
    }

    return yield* txBuilder
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "exitGroup", error: String(e) })));
  });
