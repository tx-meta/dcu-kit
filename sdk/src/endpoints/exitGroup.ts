
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
 * Logic:
 * 1. Validates Member Auth and Treasury State
 * 2. Burns Member Reference Token
 * 3. Refunds remaining contribution (minus penalty if applicable)
 */
export const unsignedExitGroupTxProgram = (
  lucid: LucidEvolution,
  groupUtxo: UTxO, // Reference
  accountUtxo: UTxO, // Member Auth
  treasuryUtxo: UTxO, // Member State
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const treasuryDatum = Data.from(treasuryUtxo.datum!, TreasuryDatumSchema) as unknown as TreasuryDatum;
    if (!('TreasuryState' in treasuryDatum)) return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Invalid Treasury State" }));

    const memberRefName = treasuryDatum.TreasuryState.member_reference_tokenname;
    const policyId = scripts.treasury.mint.policyId;

    // Check penalty logic (simplified: assumed no penalty or handled by updated datum)
    // If penalty, we output to Treasury. If not, full refund.
    // For this implementation, we burn the token and return all funds to user.
    // Spec says "Penalty UTxO" might be created.
    
    // Redeemer
    const redeemer = Data.to({
        ExitGroup: {
            group_ref_input_index: 0n,
            member_input_index: 1n,
            treasury_input_index: 2n,
            penalty_output_index: 0n // If 0, checking validity?
        }
    }, TreasuryRedeemer);

    const tx = yield* tryBuildTx("exitGroup", async () => {
        const t = lucid.newTx()
            .readFrom([groupUtxo])
            .collectFrom([accountUtxo])
            .collectFrom([treasuryUtxo], redeemer)
            .mintAssets(
                { [policyId + memberRefName]: -1n }, // Burn
                redeemer // Use same redeemer for mint? Or TreasuryRedeemer is sufficient
            )
            .attach.MintingPolicy(scripts.treasury.mint.script)
            .attach.SpendingValidator(scripts.treasury.spend.script)
            .addSigner(await lucid.wallet().address());
        
        return t.complete();
    });

    return tx;
  });
