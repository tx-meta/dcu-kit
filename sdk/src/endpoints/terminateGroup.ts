
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
import { tryBuildTx } from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for terminating a Group membership.
 * 
 * **Functionality:**
 * - Irreversibly burns a Treasury Membership token.
 * - Destroys the Treasury UTxO state and refunds remaining ADA (to the script/admin control).
 * 
 * @param lucid - Lucid instance with wallet selected.
 * @param groupUtxo - Group Reference Input for context.
 * @param treasuryUtxo - The Treasury Membership UTxO to terminate.
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
 * 
 * @example
 * ```typescript
 * const program = unsignedTerminateGroupTxProgram(lucid, 
 *   groupUtxo, treasuryUtxo, scripts
 * );
 * ```
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
