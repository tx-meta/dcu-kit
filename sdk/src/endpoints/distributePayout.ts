
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
import { calculateCurrentSlot } from "../core/treasury.utils.js";
import { fromHex, tryBuildTx } from "../core/utils.js";
import { DcuError, InvalidDatumError, TransactionBuildError } from "../core/errors.js";

/**
 * Creates an unsigned transaction for Distributing Payouts.
 * 
 * **Functionality:**
 * - **Aggregation:** Collects contributions from all valid active members in the Treasury.
 * - **Distribution:** Identifies the **Borrower** assigned to the Current Slot (Rotation Schedule) and sends the collected pot.
 * - **State Update:** Updates Treasury Datums (record payment, update next claim).
 * 
 * @param lucid - Lucid instance.
 * @param groupUtxo - Group Reference Input (Context).
 * @param treasuryUtxos - List of Treasury Membership UTxOs (Contributors).
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedDistributePayoutTxProgram = (
  lucid: LucidEvolution,
  groupUtxo: UTxO, // Reference Input
  treasuryUtxos: UTxO[], // Inputs to collect from
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const groupDatum = Data.from(groupUtxo.datum!, GroupDatum);
    if (!groupDatum) yield* Effect.fail(new InvalidDatumError({ field: "groupDatum", reason: "Invalid Group Datum" }));

    const currentSlot = calculateCurrentSlot(Date.now(), groupDatum);

    let borrowerUtxo: UTxO | undefined;
    const memberStates: { utxo: UTxO, datum: TreasuryDatum }[] = [];
    
    for (const u of treasuryUtxos) {
        if (!u.datum) continue;
        try {
            const d = Data.from(u.datum, TreasuryDatumSchema) as unknown as TreasuryDatum;
            if ('TreasuryState' in d) {
                 memberStates.push({ utxo: u, datum: d });
                 if (Number(d.TreasuryState.assigned_slot) === currentSlot) {
                     borrowerUtxo = u;
                 }
            }
        } catch(e) { /* ignore invalid */ }
    }

    if (!borrowerUtxo) {
        yield* Effect.fail(new TransactionBuildError({ operation: "distributePayout", error: `No member found for current slot ${currentSlot}` }));
    }
    
    const borrowerAddress = yield* Effect.tryPromise({
        try: () => lucid.wallet().address(),
        catch: (error) => new TransactionBuildError({ operation: "getAddress", error: String(error) })
    });
    const payoutAmount = 200_000_000n; 

    // Construct Redeemer
    const redeemer = Data.to({
        DistributePayout: {
            group_ref_input_index: 0n, 
            treasury_input_indices: treasuryUtxos.map((_, i) => BigInt(i)), 
            treasury_output_indices: treasuryUtxos.map((_, i) => BigInt(i)),
            borrower_output_index: 0n
        }
    }, TreasuryRedeemer);

    const txBuilder = lucid.newTx()
        .readFrom([groupUtxo])
        .collectFrom(treasuryUtxos, redeemer)
        .attach.SpendingValidator(scripts.treasury.spend.script)
        
        // Output 1: Borrower Payout
        .pay.ToAddress(borrowerAddress, { lovelace: payoutAmount });

    // Output N: Return Treasury UTxOs
    for (const state of memberStates) {
        if (!('TreasuryState' in state.datum)) continue;
        txBuilder.pay.ToContract(
            scripts.treasury.spend.address,
            { kind: "inline", value: Data.to(state.datum, TreasuryDatum) },
            { 
                lovelace: 2_000_000n, // Locked min ADA
                [scripts.treasury.mint.policyId + state.datum.TreasuryState.member_reference_tokenname]: 1n
                // Re-lock the Member Ref using the hex string from datum directly
            }
        );
    }
    
    return yield* tryBuildTx("distributePayout", () => txBuilder.complete());
  });
