
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
import { treasuryValidator, treasuryPolicyId } from "../core/validators/constants.js";
import { DcuError, InvalidDatumError, TransactionBuildError } from "../core/errors.js";
import { getWalletAddress } from "../core/utils/index.js";

// --- Configuration ---

export type TerminateGroupConfig = {
    groupUtxo: UTxO;
    treasuryUtxo: UTxO;
};

// --- Endpoint ---

/**
 * Creates an unsigned transaction for terminating a Group membership.
 * 
 * **Functionality:**
 * - Irreversibly burns a Treasury Membership token.
 * - Destroys the Treasury UTxO state and refunds remaining ADA (to the script/admin control).
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
    const { groupUtxo, treasuryUtxo } = config;

    const treasuryDatum = Data.from(treasuryUtxo.datum!, TreasuryDatumSchema) as unknown as TreasuryDatum;
    // Check for valid state
    if (!('TreasuryState' in treasuryDatum) && !('PenaltyState' in treasuryDatum)) {
         return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Invalid Treasury State" }));
    }

    // Extract token name from state (check both variants)
    const memberRefName = 'TreasuryState' in treasuryDatum 
        ? treasuryDatum.TreasuryState.member_reference_tokenname 
        : treasuryDatum.PenaltyState.member_reference_tokenname;

    const policyId = treasuryPolicyId;

    // Redeemer: TerminateGroup (Unit Variant)
    const redeemer = Data.to({
        TerminateGroup: "TerminateGroup" 
    }, TreasuryRedeemer);

    const address = yield* getWalletAddress(lucid);

    // Note: same redeemer is used for both Spending (Treasury UTxO) and Minting (Burn).
    return yield* lucid
        .newTx()
        .readFrom([groupUtxo])
        .collectFrom([treasuryUtxo], redeemer)
        .mintAssets(
            { [policyId + memberRefName]: -1n },
            redeemer
        )
        .attach.MintingPolicy(treasuryValidator.mintTreasury)
        .attach.SpendingValidator(treasuryValidator.spendTreasury)
        .addSigner(address)
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "terminateGroup", error: String(e) })));
  });
