
import { 
    Data, 
    LucidEvolution, 
    UTxO, 
    TxSignBuilder 
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { 
    GroupDatum, 
    TreasuryDatum, 
    TreasuryDatumSchema, 
    TreasuryRedeemer 
} from "../core/types.js";
import { DcuValidators } from "../core/validators/context.js";
import { DcuError, InvalidDatumError, TransactionBuildError } from "../core/errors.js";
import { tryBuildTx } from "../core/utils.js";

/**
 * Creates an unsigned transaction for Exiting a Group.
 * 
 * **Functionality:**
 * - **Early Exit:** Transitions Treasury UTxO to PenaltyState (fee deduction, token retained).
 * - **Mature Exit:** Burns Membership Token (full refund).
 * 
 * @param lucid - Lucid instance.
 * @param groupUtxo - Group Reference Input.
 * @param accountUtxo - Member Auth Input.
 * @param treasuryUtxo - Treasury Membership Input.
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedExitGroupTxProgram = (
  lucid: LucidEvolution,
  groupUtxo: UTxO, // Reference Input
  accountUtxo: UTxO, // Member Auth Input
  treasuryUtxo: UTxO, // Treasury Membership Input
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const treasuryDatum = Data.from(treasuryUtxo.datum!, TreasuryDatumSchema) as unknown as TreasuryDatum;
    if (!('TreasuryState' in treasuryDatum)) return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Invalid Treasury State" }));

    const memberRefName = treasuryDatum.TreasuryState.member_reference_tokenname;
    const policyId = scripts.treasury.mint.policyId;

    const groupDatum = Data.from(groupUtxo.datum!, GroupDatum);
    if (!groupDatum) return yield* Effect.fail(new InvalidDatumError({ field: "groupDatum", reason: "Invalid Group Datum" }));

    const now = BigInt(Date.now());
    const maturityTime = groupDatum.start_time + (groupDatum.num_intervals * groupDatum.interval_length);
    const isEarlyExit = groupDatum.is_active && (now < maturityTime);

    // Redeemer construction: Indices correspond to the specific UTxO positions in the built transaction.
    const redeemer = Data.to({
        ExitGroup: {
            group_ref_input_index: 0n,
            member_input_index: 1n,
            treasury_input_index: 2n,
            penalty_output_index: 0n 
        }
    }, TreasuryRedeemer);

    const tx = yield* tryBuildTx("exitGroup", async () => {
        const t = lucid.newTx()
            .readFrom([groupUtxo])
            .collectFrom([accountUtxo])
            .collectFrom([treasuryUtxo], redeemer)
            .attach.MintingPolicy(scripts.treasury.mint.script)
            .attach.SpendingValidator(scripts.treasury.spend.script)
            .addSigner(await lucid.wallet().address());

        if (isEarlyExit) {
             const penaltyDatum: TreasuryDatum = {
                PenaltyState: {
                    group_reference_tokenname: treasuryDatum.TreasuryState.group_reference_tokenname,
                    member_reference_tokenname: treasuryDatum.TreasuryState.member_reference_tokenname
                }
             };
             
             // Transition to Penalty State (Keep Token)
             t.pay.ToContract(
                 scripts.treasury.spend.address,
                 { kind: "inline", value: Data.to(penaltyDatum, TreasuryDatum) },
                 { 
                     lovelace: 2_000_000n + groupDatum.penalty_fee, // Lock Min ADA + Penalty
                     [policyId + memberRefName]: 1n // Keep Token
                 }
             );
        } else {
            // Mature Exit: Burn Token
            t.mintAssets(
                { [policyId + memberRefName]: -1n }, 
                redeemer 
            );
        }
        
        return t.complete();
    });

    return tx;
  });
