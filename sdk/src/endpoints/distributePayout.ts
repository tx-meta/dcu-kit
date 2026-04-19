
import {
    Data,
    LucidEvolution,
    UTxO,
    TxSignBuilder,
    RedeemerBuilder,
    Assets,
    toUnit,
    credentialToAddress
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { 
    GroupDatum, 
    TreasuryDatum, 
    TreasuryDatumSchema, 
    TreasuryRedeemer 
} from "../core/types.js";
import { treasuryValidator, treasuryPolicyId } from "../core/validators/constants.js";
import { getScriptAddress, parseSafeDatum, calculateCurrentSlot } from "../core/utils/index.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";

/**
 * Creates an unsigned transaction for distributing payouts in a Group.
 * 
 * **Functionality:**
 * - Aggregates contributions from active members in the Treasury.
 * - Identifies the Borrower assigned to the current rotation slot.
 * - Distributes the collected pot to the borrower.
 * - Updates Treasury states to reflect the payout.
 * 
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Distribute Payout Configuration.
 * @returns Effect yielding TxSignBuilder.
 * 
 * @example
 * ```typescript
 * const program = unsignedDistributePayoutTxProgram(lucid, 
 *   { groupUtxo, treasuryUtxos }
 * );
 * ```
 */
export type DistributePayoutConfig = {
    groupUtxo: UTxO;
    treasuryUtxos: UTxO[];
};

export const unsignedDistributePayoutTxProgram = (
  lucid: LucidEvolution,
  config: DistributePayoutConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupUtxo, treasuryUtxos } = config;
    const groupDatum = yield* parseSafeDatum(groupUtxo.datum, GroupDatum);
    const currentSlot = calculateCurrentSlot(Date.now(), groupDatum);

    // Parse all treasury UTxO datums, silently skipping ones with invalid datums
    const parsedStates = yield* Effect.all(
        treasuryUtxos.map(u =>
            parseSafeDatum(u.datum, TreasuryDatumSchema).pipe(
                Effect.map(raw => ({ utxo: u, datum: raw as unknown as TreasuryDatum })),
                Effect.orElse(() => Effect.succeed(null))
            )
        ),
        { concurrency: "unbounded" }
    );

    let borrowerUtxo: UTxO | undefined;
    let borrowerPaymentCred: string | undefined;
    const memberStates: { utxo: UTxO, datum: TreasuryDatum }[] = [];

    for (const state of parsedStates) {
        if (!state || !('TreasuryState' in state.datum)) continue;
        memberStates.push(state);
        if (Number(state.datum.TreasuryState.assigned_slot) === currentSlot) {
            borrowerUtxo = state.utxo;
            borrowerPaymentCred = state.datum.TreasuryState.member_payment_credential;
        }
    }

    if (!borrowerUtxo || !borrowerPaymentCred) {
        yield* Effect.fail(new TransactionBuildError({ operation: "distributePayout", error: `No member found for current slot ${currentSlot}` }));
    }

    // Use a single `now` for both claimable calculations and validFrom —
    // Aiken reads get_lower_bound(tx) for all time comparisons.
    const currentTime = BigInt(Date.now());
    let payoutAmount = 0n;
    const outputStates: { utxo: UTxO, datum: TreasuryDatum, remainingLovelace: bigint }[] = [];

    for (const state of memberStates) {
        if (!('TreasuryState' in state.datum)) continue;
        const ts = state.datum.TreasuryState;

        const claimable = ts.contribution_list.filter(c => c.claimable_at <= currentTime);
        const contributed = claimable.reduce((sum, c) => sum + c.claimable_amount, 0n);
        payoutAmount += contributed;

        // Updated datum: remove claimable entries (mark as paid)
        const updatedDatum: TreasuryDatum = {
            TreasuryState: {
                group_reference_tokenname: ts.group_reference_tokenname,
                member_reference_tokenname: ts.member_reference_tokenname,
                membership_start: ts.membership_start,
                assigned_slot: ts.assigned_slot,
                contribution_list: ts.contribution_list.filter(c => c.claimable_at > currentTime),
                member_payment_credential: ts.member_payment_credential,
            }
        };
        outputStates.push({ utxo: state.utxo, datum: updatedDatum, remainingLovelace: state.utxo.assets.lovelace - contributed });
    }

    if (payoutAmount === 0n) {
        yield* Effect.fail(new TransactionBuildError({ operation: "distributePayout", error: "No claimable contributions found for the current interval" }));
    }

    // Aiken checks borrower_output.address.payment_credential == VerificationKey(member_payment_credential).
    // Must use the credential stored at join time, not the caller's wallet.
    const network = lucid.config().network!;
    const borrowerAddress = credentialToAddress(network, { type: "Key", hash: borrowerPaymentCred! });

    // Construct Redeemer using RedeemerBuilder
    const redeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => {
            // Map input indices to output indices (1-based for Treasury outputs)
            const outputIndices = inputIndices.map((_, i) => BigInt(i + 1));

            return Data.to({
                DistributePayout: {
                    group_ref_input_index: 0n,
                    treasury_input_indices: inputIndices,
                    treasury_output_indices: outputIndices,
                    borrower_output_index: 0n
                }
            }, TreasuryRedeemer);
        },
        inputs: treasuryUtxos
    };

    const treasuryAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);

    const tx = yield* outputStates
        .reduce((builder, state) => {
            if (!('TreasuryState' in state.datum)) return builder;
            const memberToken = toUnit(treasuryPolicyId!, state.datum.TreasuryState.member_reference_tokenname);
            const memberTreasuryAssets: Assets = { lovelace: state.remainingLovelace, [memberToken]: 1n };
            return builder.pay.ToContract(
                treasuryAddress,
                { kind: "inline", value: Data.to(state.datum, TreasuryDatum) },
                memberTreasuryAssets
            );
        }, lucid.newTx()
            .readFrom([groupUtxo])
            .collectFrom(treasuryUtxos, redeemer)
            .pay.ToAddress(borrowerAddress, { lovelace: payoutAmount }))
        .validFrom(Number(currentTime))
        .attach.SpendingValidator(treasuryValidator.spendTreasury)
        // localUPLCEval: false — the Lucid Evolution UPLC wasm does not pass reference_inputs
        // to PlutusV3 scripts correctly. The emulator accepts zero ex_units; live networks
        // use the provider's evaluateTx (real Cardano node) which handles reference inputs.
        .completeProgram({ localUPLCEval: false })
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "distributePayout", error: String(e) })));
    return tx;
  });
