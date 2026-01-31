
import { 
    Data, 
    LucidEvolution, 
    UTxO, 
    TxSignBuilder 
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
 */
export const unsignedMemberWithdrawTxProgram = (
  lucid: LucidEvolution,
  groupUtxo: UTxO, // Reference
  accountUtxo: UTxO, // Auth
  treasuryUtxo: UTxO, // Source
  withdrawAmount: bigint,
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const treasuryDatum = Data.from(treasuryUtxo.datum!, TreasuryDatumSchema) as unknown as TreasuryDatum;
    if (!('TreasuryState' in treasuryDatum)) return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Invalid Treasury State" }));

    const memberRefName = treasuryDatum.TreasuryState.member_reference_tokenname;
    const policyId = scripts.treasury.mint.policyId;

    // Redeemer
    const redeemer = Data.to({
        MemberWithdraw: {
            group_ref_input_index: 0n,
            member_input_index: 1n,
            treasury_input_index: 2n,
            treasury_output_index: 0n,
            loans_withdrawn: withdrawAmount
        }
    }, TreasuryRedeemer);

    const tx = yield* tryBuildTx("memberWithdraw", async () => {
         const t = lucid.newTx()
            .readFrom([groupUtxo])
            .collectFrom([accountUtxo])
            .collectFrom([treasuryUtxo], redeemer)
            .attach.SpendingValidator(scripts.treasury.spend.script)
            
            // Output 1: Return remaining logic
            // We pay back to script with SAME datum (simplified)
            .pay.ToContract(
                scripts.treasury.spend.address,
                { kind: "inline", value: Data.to(treasuryDatum, TreasuryDatum) },
                { 
                   lovelace: 2_000_000n, // Placeholder remaining
                   [policyId + memberRefName]: 1n
                }
            )
            // Output 2: User Withdrawal (To Address of Signer)
            .pay.ToAddress(await lucid.wallet().address(), { lovelace: withdrawAmount });

         return t.complete();
    });

    return tx;
  });
