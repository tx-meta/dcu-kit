
import {
    Data,
    LucidEvolution,
    UTxO,
    TxSignBuilder,
    fromText,
    RedeemerBuilder
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

// --- Configuration ---

export type TerminateGroupConfig = {
    groupUtxo: UTxO;   // Must be spending input — treasury reads its script credential
    adminUtxo: UTxO;   // Must hold the group (222) admin token for auth
    treasuryUtxo: UTxO; // Must be PenaltyState
};

// --- Endpoint ---

/**
 * Creates an unsigned transaction for terminating a Group membership (penalty withdrawal).
 *
 * **Functionality:**
 * - Admin withdraws a PenaltyState Treasury UTxO after member early exit.
 * - Burns the membership token and releases locked ADA to the admin.
 * - Requires the group UTxO as a spending input (to derive group policy for admin auth).
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - TerminateGroupConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedTerminateGroupTxProgram = (
  lucid: LucidEvolution,
  config: TerminateGroupConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupUtxo, adminUtxo, treasuryUtxo } = config;

    const treasuryDatum = (yield* parseSafeDatum(treasuryUtxo.datum, TreasuryDatumSchema)) as unknown as TreasuryDatum;
    if (!('PenaltyState' in treasuryDatum)) {
        return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Expected PenaltyState for TerminateGroup" }));
    }

    const memberRefName = treasuryDatum.PenaltyState.member_reference_tokenname;
    const policyId = treasuryPolicyId;

    const groupDatum = yield* parseSafeDatum(groupUtxo.datum, GroupDatum);

    const groupRefAssetEntry = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicyId!));
    const groupRefName = groupRefAssetEntry
        ? groupRefAssetEntry.slice(groupPolicyId!.length)
        : fromText("GroupReference");

    // Group validator redeemer: UpdateGroup — admin spends group UTxO and returns it unchanged.
    // This is required because the treasury validator reads the group input from tx.inputs
    // (spending inputs) to derive the group policy ID for admin token verification.
    const groupRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            UpdateGroup: {
                group_ref_token_name: groupRefName,
                admin_input_index: inputIndices[1],
                group_input_index: inputIndices[0],
                group_output_index: 0n
            }
        }, GroupSpendRedeemer),
        inputs: [groupUtxo, adminUtxo]
    };

    // Treasury validator redeemer: TerminateGroup
    const treasuryRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            TerminateGroup: {
                group_input_index: inputIndices[0],
                admin_input_index: inputIndices[1],
            }
        }, TreasuryRedeemer),
        inputs: [groupUtxo, adminUtxo]
    };

    const address = yield* getWalletAddress(lucid);
    const groupAddress = yield* getScriptAddress(lucid, groupValidator.spendGroup);

    return yield* lucid
        .newTx()
        .collectFrom([groupUtxo], groupRedeemer)
        .collectFrom([adminUtxo])
        .collectFrom([treasuryUtxo], treasuryRedeemer)
        .mintAssets(
            { [policyId + memberRefName]: -1n },
            treasuryRedeemer
        )
        .attach.MintingPolicy(treasuryValidator.mintTreasury)
        .attach.SpendingValidator(treasuryValidator.spendTreasury)
        .attach.SpendingValidator(groupValidator.spendGroup)
        .addSigner(address)
        // Output 0: Return Group UTxO unchanged (UpdateGroup path)
        .pay.ToContract(
            groupAddress,
            { kind: "inline", value: Data.to(groupDatum, GroupDatum) },
            groupUtxo.assets
        )
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "terminateGroup", error: String(e) })));
  });
