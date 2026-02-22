
import { 
    Data, 
    LucidEvolution, 
    UTxO, 
    TxSignBuilder,
    RedeemerBuilder 
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { 
    GroupDatum, 
    TreasuryDatum, 
    TreasuryDatumSchema, 
    TreasuryRedeemer 
} from "../core/types.js";
import { treasuryValidator, treasuryPolicyId } from "../core/validators/constants.js";
import { DcuError, InvalidDatumError, TransactionBuildError } from "../core/errors.js";
import { getScriptAddress, getWalletAddress, parseSafeDatum } from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for exiting a Group.
 * 
 * **Functionality:**
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

    const now = BigInt(Date.now());
    const maturityTime = groupDatum.start_time + (groupDatum.num_intervals * groupDatum.interval_length);
    const isEarlyExit = groupDatum.is_active && (now < maturityTime);

    // Redeemer construction: Indices correspond to the specific UTxO positions in the built transaction.
    // Redeemer construction using RedeemerBuilder
    const redeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => {
            return Data.to({
                ExitGroup: {
                    group_ref_input_index: 0n, // Ref input (assuming only one)
                    member_input_index: inputIndices[0],
                    treasury_input_index: inputIndices[1],
                    penalty_output_index: 0n 
                }
            }, TreasuryRedeemer);
        },
        inputs: [accountUtxo, treasuryUtxo]
    };

    const address = yield* getWalletAddress(lucid);
    const treasuryAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);

    const txBuilder = lucid.newTx()
        .readFrom([groupUtxo])
        .collectFrom([accountUtxo])
        .collectFrom([treasuryUtxo], redeemer)
        .attach.MintingPolicy(treasuryValidator.mintTreasury)
        .attach.SpendingValidator(treasuryValidator.spendTreasury)
        .addSigner(address);

    if (isEarlyExit) {
        const penaltyDatum: TreasuryDatum = {
            PenaltyState: {
                group_reference_tokenname: treasuryDatum.TreasuryState.group_reference_tokenname,
                member_reference_tokenname: treasuryDatum.TreasuryState.member_reference_tokenname
            }
        };
        // Transition to Penalty State (Keep Token)
        txBuilder.pay.ToContract(
            treasuryAddress,
            { kind: "inline", value: Data.to(penaltyDatum, TreasuryDatum) },
            {
                lovelace: 2_000_000n + groupDatum.penalty_fee, // Lock Min ADA + Penalty
                [policyId + memberRefName]: 1n // Keep Token
            }
        );
    } else {
        // Mature Exit: Burn Token
        txBuilder.mintAssets(
            { [policyId + memberRefName]: -1n },
            redeemer
        );
    }

    return yield* txBuilder
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "exitGroup", error: String(e) })));
  });
