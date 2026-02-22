
import { 
    Data, 
    LucidEvolution, 
    UTxO, 
    TxSignBuilder,
    RedeemerBuilder 
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { 
    TreasuryDatum, 
    TreasuryDatumSchema, 
    TreasuryRedeemer 
} from "../core/types.js";
import { treasuryValidator, treasuryPolicyId } from "../core/validators/constants.js";
import { DcuError, InvalidDatumError, TransactionBuildError } from "../core/errors.js";
import { getScriptAddress, getWalletAddress } from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for a member withdrawal from the Treasury.
 * 
 * **Functionality:**
 * - Allows a member to withdraw their allocated funds (loan/payout).
 * - Ensures remaining Treasury funds are preserved and returned to the script.
 * 
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Member Withdraw Configuration.
 * @returns Effect yielding TxSignBuilder.
 * 
 * @example
 * ```typescript
 * const program = unsignedMemberWithdrawTxProgram(lucid, 
 *   { groupUtxo, accountUtxo, treasuryUtxo, withdrawAmount }
 * );
 * ```
 */
export type MemberWithdrawConfig = {
    groupUtxo: UTxO;
    accountUtxo: UTxO;
    treasuryUtxo: UTxO;
    withdrawAmount: bigint;
};

export const unsignedMemberWithdrawTxProgram = (
  lucid: LucidEvolution,
  config: MemberWithdrawConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupUtxo, accountUtxo, treasuryUtxo, withdrawAmount } = config;
    const treasuryDatum = Data.from(treasuryUtxo.datum!, TreasuryDatumSchema) as unknown as TreasuryDatum;
    if (!('TreasuryState' in treasuryDatum)) return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Invalid Treasury State" }));

    const memberRefName = treasuryDatum.TreasuryState.member_reference_tokenname;
    const policyId = treasuryPolicyId!;

    // Calculate remaining Treasury Balance
    const currentTreasuryBalance = treasuryUtxo.assets.lovelace;
    if (currentTreasuryBalance < withdrawAmount + 2_000_000n) {
         // Basic safety check: Ensure enough remains for min ADA
         return yield* Effect.fail(new TransactionBuildError({ operation: "memberWithdraw", error: "Insufficient funds in Treasury UTxO" }));
    }
    const remainingBalance = currentTreasuryBalance - withdrawAmount;

    const redeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => {
            return Data.to({
                MemberWithdraw: {
                    group_ref_input_index: 0n, // Only 1 ref input (groupUtxo) -> Index 0
                    member_input_index: inputIndices[0],
                    treasury_input_index: inputIndices[1],
                    treasury_output_index: 0n,
                    loans_withdrawn: withdrawAmount
                }
            }, TreasuryRedeemer);
        },
        inputs: [accountUtxo, treasuryUtxo]
    };

    const address = yield* getWalletAddress(lucid);
    const treasuryAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);

    return yield* lucid.newTx()
        .readFrom([groupUtxo])
        .collectFrom([accountUtxo])
        .collectFrom([treasuryUtxo], redeemer)
        .attach.SpendingValidator(treasuryValidator.spendTreasury)
        // Output 1: Return remaining balance to Treasury
        .pay.ToContract(
            treasuryAddress,
            { kind: "inline", value: Data.to(treasuryDatum, TreasuryDatum) },
            {
                lovelace: remainingBalance,
                [policyId + memberRefName]: 1n
            }
        )
        // Output 2: User Withdrawal
        .pay.ToAddress(address, { lovelace: withdrawAmount })
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "memberWithdraw", error: String(e) })));
  });
