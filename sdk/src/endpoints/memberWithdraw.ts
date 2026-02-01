
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
import { DcuValidators } from "../core/validators/context.js";
import { DcuError, InvalidDatumError, TransactionBuildError } from "../core/errors.js";
import { tryBuildTx } from "../core/utils.js";

/**
 * Creates an unsigned transaction for Member Withdrawal.
 * 
 * **Functionality:**
 * - Allows a member to withdraw funds (e.g., a loan or payout) from their Treasury allocation.
 * 
 * **Critical Logic:**
 * - **Balance Preservation:** Calculates `Input Balance - Withdrawal Amount` to ensure remaining funds are sent back to the Treasury.
 * - **Vesting Check:** Assumes Validator enforces vesting limits based on current slot.
 * 
 * @param lucid - Lucid instance.
 * @param groupUtxo - Group Reference Input (Context).
 * @param accountUtxo - User Auth UTxO.
 * @param treasuryUtxo - Treasury Membership UTxO (Source of funds).
 * @param withdrawAmount - Amount to withdraw (in Lovelace).
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedMemberWithdrawTxProgram = (
  lucid: LucidEvolution,
  groupUtxo: UTxO, // Reference Input
  accountUtxo: UTxO, // Auth Input
  treasuryUtxo: UTxO, // Source Input
  withdrawAmount: bigint,
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const treasuryDatum = Data.from(treasuryUtxo.datum!, TreasuryDatumSchema) as unknown as TreasuryDatum;
    if (!('TreasuryState' in treasuryDatum)) return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Invalid Treasury State" }));

    const memberRefName = treasuryDatum.TreasuryState.member_reference_tokenname;
    const policyId = scripts.treasury.mint.policyId;

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
            // [accountUtxo, treasuryUtxo] -> [memberIndex, treasuryIndex]
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

    const tx = yield* tryBuildTx("memberWithdraw", async () => {
         const t = lucid.newTx()
            .readFrom([groupUtxo])
            .collectFrom([accountUtxo])
            .collectFrom([treasuryUtxo], redeemer)
            .attach.SpendingValidator(scripts.treasury.spend.script)
            
            // Output 1: Return remaining balance to Treasury
            .pay.ToContract(
                scripts.treasury.spend.address,
                { kind: "inline", value: Data.to(treasuryDatum, TreasuryDatum) },
                { 
                   lovelace: remainingBalance,
                   [policyId + memberRefName]: 1n
                }
            )
            // Output 2: User Withdrawal (To Address of Signer)
            .pay.ToAddress(await lucid.wallet().address(), { lovelace: withdrawAmount });

         return t.complete();
    });

    return tx;
  });
