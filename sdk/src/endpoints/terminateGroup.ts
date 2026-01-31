
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
import { DcuError, InvalidDatumError } from "../core/errors.js";
import { tryBuildTx } from "../core/utils.js";

/**
 * Creates an unsigned transaction for Terminating a Group Membership.
 * 
 * **Functionality:**
 * - **Force Burn:** Irreversibly burns the Membership Token.
 * - **Context:** Typically used for administrative cleanup.
 * 
 * @param lucid - Lucid instance.
 * @param groupUtxo - Group Reference Input.
 * @param treasuryUtxo - The Treasury UTxO to burn.
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedTerminateGroupTxProgram = (
  lucid: LucidEvolution,
  groupUtxo: UTxO, // Reference Input
  treasuryUtxo: UTxO, // The UTxO holding the membership token to be burned
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const treasuryDatum = Data.from(treasuryUtxo.datum!, TreasuryDatumSchema) as unknown as TreasuryDatum;
    if (!('TreasuryState' in treasuryDatum)) return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Invalid Treasury State" }));

    const memberRefName = treasuryDatum.TreasuryState.member_reference_tokenname;
    const policyId = scripts.treasury.mint.policyId;

    // Redeemer: TerminateGroup (Variant 1)
    const redeemer = Data.to({
        TerminateGroup: "TerminateGroup" 
    }, TreasuryRedeemer);

    const tx = yield* tryBuildTx("terminateGroup", async () => {
        const t = lucid.newTx()
            .readFrom([groupUtxo])
            // Note: We use the same redeemer for both Spending (Treasury UTxO) and Minting (Burn).
            // This assumes the Treasury Validator accepts TerminateGroup for both purposes.
            .collectFrom([treasuryUtxo], redeemer) 
            .mintAssets(
                { [policyId + memberRefName]: -1n },
                redeemer
            )
            .attach.MintingPolicy(scripts.treasury.mint.script)
            .attach.SpendingValidator(scripts.treasury.spend.script)
            .addSigner(await lucid.wallet().address());
        
        return t.complete();
    });

    return tx;
  });
