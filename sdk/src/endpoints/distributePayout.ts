
import {
    Data,
    LucidEvolution,
    TxSignBuilder,
    RedeemerBuilder,
    UTxO,
    toUnit,
    credentialToAddress
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
    GroupDatum,
    GroupSpendRedeemer,
    TreasuryDatum,
    TreasuryDatumSchema,
    TreasuryRedeemer
} from "../core/types.js";
import { treasuryValidator, treasuryPolicyId, groupPolicyId, groupValidator } from "../core/validators/constants.js";
import { getScriptAddress, parseSafeDatum, patchInlineDatum, assetNameLabels, resolveUtxoByUnit } from "../core/utils/index.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";

/**
 * Creates an unsigned transaction for distributing a single ROSCA round.
 *
 * **Functionality:**
 * - Identifies the next round (group.last_distributed_round + 1).
 * - Spends the group UTxO to atomically increment last_distributed_round.
 * - Each member treasury contributes contribution_fee; the assigned borrower receives
 *   the full pot (contribution_fee × member_count).
 * - Updates all treasury datums (rounds_paid + 1, is_deferred reset to false).
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Distribute Round Configuration.
 * @returns Effect yielding TxSignBuilder.
 */
export type DistributePayoutConfig = {
    groupTokenSuffix: string;
    currentTime?: bigint;  // POSIX ms — emulator.now() for emulator, omit for live
    // Reference script UTxOs (from deploy-scripts). When provided, the validator
    // script bytes are resolved from the on-chain UTxO rather than included inline,
    // keeping the transaction well under the 16KB Cardano size limit.
    scriptRefs?: {
        treasury?: UTxO;
        group?: UTxO;
    };
};

export const unsignedDistributePayoutTxProgram = (
  lucid: LucidEvolution,
  config: DistributePayoutConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupTokenSuffix } = config;

    const groupRefUnit = groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const groupUtxo    = patchInlineDatum(groupUtxoRaw);

    const groupDatum = yield* parseSafeDatum(groupUtxo.datum, GroupDatum);

    const groupRefAsset = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicyId!));
    if (!groupRefAsset) return yield* Effect.fail(new TransactionBuildError({ operation: "distributeRound", error: "Group reference token not found in group UTxO" }));
    const groupRefName = groupRefAsset.slice(groupPolicyId!.length);

    if (!groupDatum.is_started) {
        return yield* Effect.fail(new TransactionBuildError({ operation: "distributeRound", error: "Group has not been started — call startGroup first" }));
    }
    if (groupDatum.num_intervals === 0n) {
        return yield* Effect.fail(new TransactionBuildError({ operation: "distributeRound", error: "Group has zero intervals — call startGroup first" }));
    }

    const roundNumber = groupDatum.last_distributed_round + 1n;
    if (roundNumber >= groupDatum.num_intervals) {
        return yield* Effect.fail(new TransactionBuildError({
            operation: "distributeRound",
            error: `All ${groupDatum.num_intervals} rounds have been distributed (rounds 0–${groupDatum.num_intervals - 1n} complete). Group is mature — members can now call exit-group.`,
        }));
    }

    const currentSlot = Number(roundNumber % groupDatum.num_intervals);

    const treasuryAddress  = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);
    const groupAddress     = yield* getScriptAddress(lucid, groupValidator.spendGroup);
    const rawTreasuryUtxos = yield* Effect.tryPromise({
        try: () => lucid.utxosAt(treasuryAddress),
        catch: (e) => new TransactionBuildError({ operation: "queryTreasury", error: String(e) }),
    });
    const treasuryUtxos = rawTreasuryUtxos.map(patchInlineDatum);

    const parsedStates = yield* Effect.all(
        treasuryUtxos.map(u =>
            parseSafeDatum(u.datum, TreasuryDatumSchema).pipe(
                Effect.map(raw => ({ utxo: u, datum: raw as unknown as TreasuryDatum })),
                Effect.orElse(() => Effect.succeed(null))
            )
        ),
        { concurrency: "unbounded" }
    );

    // Filter to TreasuryState UTxOs belonging to this group that are ready for this round.
    // Also capture is_deferred for the primary slot holder — mirrors the Aiken routing:
    //   if primary is deferred → effectiveSlot = (currentSlot + 1) % num_intervals
    const memberStates: { utxo: UTxO; datum: TreasuryDatum }[] = [];
    let primaryPaymentCred: string | undefined;
    let primaryIsDeferred = false;
    const credBySlot = new Map<number, string>();

    for (const state of parsedStates) {
        if (!state || !('TreasuryState' in state.datum)) continue;
        const ts = state.datum.TreasuryState;
        if (ts.group_reference_tokenname !== groupRefName) continue;
        if (ts.rounds_paid !== roundNumber) continue;
        memberStates.push(state);
        credBySlot.set(Number(ts.assigned_slot), ts.member_payment_credential);
        if (Number(ts.assigned_slot) === currentSlot) {
            primaryPaymentCred  = ts.member_payment_credential;
            primaryIsDeferred   = ts.is_deferred;
        }
    }

    if (memberStates.length === 0) {
        return yield* Effect.fail(new TransactionBuildError({ operation: "distributeRound", error: `No treasury UTxOs ready for round ${roundNumber}` }));
    }
    if (!primaryPaymentCred) {
        return yield* Effect.fail(new TransactionBuildError({ operation: "distributeRound", error: `No member found for current slot ${currentSlot}` }));
    }

    // Mirror Aiken spec DistributeRound 6b: deferred primary → next slot receives the payout.
    const numIntervals = Number(groupDatum.num_intervals);
    const effectiveSlot = primaryIsDeferred
        ? (currentSlot + 1) % numIntervals
        : currentSlot;
    const borrowerPaymentCred = primaryIsDeferred
        ? credBySlot.get(effectiveSlot)
        : primaryPaymentCred;

    if (!borrowerPaymentCred) {
        return yield* Effect.fail(new TransactionBuildError({
            operation: "distributeRound",
            error: `Primary slot ${currentSlot} is deferred but no member found at effective slot ${effectiveSlot}`,
        }));
    }

    // Sort inputs lexicographically (same order Cardano uses for tx.inputs)
    memberStates.sort((a, b) => {
        const cmp = a.utxo.txHash.localeCompare(b.utxo.txHash);
        return cmp !== 0 ? cmp : a.utxo.outputIndex - b.utxo.outputIndex;
    });

    const payoutAmount = BigInt(memberStates.length) * groupDatum.contribution_fee;

    // 120 s buffer covers Blockfrost slot lag (observed up to ~30 s on Preprod).
    const VALIDITY_BUFFER_MS = lucid.config().network === "Custom" ? 0n : 120_000n;
    const currentTime = config.currentTime !== undefined
        ? config.currentTime
        : BigInt(Date.now()) - VALIDITY_BUFFER_MS;

    // The validator requires the tx lower-bound >= start_time + round * interval.
    const minValidFrom = groupDatum.start_time + roundNumber * groupDatum.interval_length;

    // Pre-check on live networks only: if the raw wall-clock time is before the gate,
    // give a clear message rather than letting the validator fail cryptically.
    // Skipped on the emulator (Custom) where timing is driven by advanceBlock(), not Date.now().
    if (lucid.config().network !== "Custom") {
        const rawNow = BigInt(Date.now());
        if (rawNow < minValidFrom) {
            const waitSecs = Math.ceil(Number(minValidFrom - rawNow) / 1000);
            const opensAt  = new Date(Number(minValidFrom)).toUTCString();
            return yield* Effect.fail(new TransactionBuildError({
                operation: "distributeRound",
                error: `Round ${roundNumber} is not yet open — opens in ~${waitSecs}s (at ${opensAt})`,
            }));
        }
    }

    const validFrom = currentTime > minValidFrom ? currentTime : minValidFrom;

    const network = lucid.config().network!;
    const borrowerAddress = credentialToAddress(network, { type: "Key", hash: borrowerPaymentCred });

    const updatedGroupDatum: GroupDatum = {
        ...groupDatum,
        last_distributed_round: roundNumber,
    };

    // Output layout: [0] group, [1..n] treasury outputs, [n+1] borrower
    const borrowerOutputIndex = BigInt(1 + memberStates.length);

    const allInputs = [groupUtxo, ...memberStates.map(s => s.utxo)];

    const groupRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (indices: bigint[]) => Data.to({
            DistributeRound: {
                group_ref_token_name: groupRefName,
                group_input_index: indices[0],
                group_output_index: 0n,
                round_number: roundNumber,
            }
        }, GroupSpendRedeemer),
        inputs: [groupUtxo],
    };

    const treasuryRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (indices: bigint[]) => {
            const groupIdx = indices[0];
            const treasuryIndices = indices.slice(1);
            const treasuryOutIndices = treasuryIndices.map((_, i) => BigInt(i + 1));
            return Data.to({
                DistributeRound: {
                    round_number: roundNumber,
                    group_ref_input_index: groupIdx,
                    group_output_index: 0n,
                    treasury_input_indices: treasuryIndices,
                    treasury_output_indices: treasuryOutIndices,
                    borrower_output_index: borrowerOutputIndex,
                }
            }, TreasuryRedeemer);
        },
        inputs: allInputs,
    };

    // Build the transaction: group output first, then treasury outputs, then borrower
    const baseTxNoValidators = lucid.newTx()
        .collectFrom([groupUtxo], groupRedeemer)
        .collectFrom(memberStates.map(s => s.utxo), treasuryRedeemer);

    // Use reference scripts when provided — avoids including ~15KB of script bytes
    // inline, keeping the tx under Cardano's 16,384-byte size limit.
    const baseTx = (config.scriptRefs?.treasury || config.scriptRefs?.group)
        ? baseTxNoValidators.readFrom(
              [config.scriptRefs?.treasury, config.scriptRefs?.group].filter(Boolean) as UTxO[]
          )
        : baseTxNoValidators
              .attach.SpendingValidator(groupValidator.spendGroup)
              .attach.SpendingValidator(treasuryValidator.spendTreasury);

    const baseTxWithGroup = baseTx.pay.ToContract(
            groupAddress,
            { kind: "inline", value: Data.to(updatedGroupDatum, GroupDatum) },
            groupUtxo.assets,
        );

    const isLastRound = roundNumber + 1n === groupDatum.num_intervals;

    const withTreasuryOutputs = memberStates.reduce((tx, state) => {
        if (!('TreasuryState' in state.datum)) return tx;
        const ts = state.datum.TreasuryState;
        const memberToken = toUnit(treasuryPolicyId!, ts.member_reference_tokenname);
        const inputLovelace = state.utxo.assets.lovelace;
        const outputLovelace = inputLovelace - groupDatum.contribution_fee;
        const transitionToIcs = outputLovelace < groupDatum.contribution_fee && !isLastRound;

        const updatedDatum: TreasuryDatum = transitionToIcs
            ? {
                InsufficientCollateralState: {
                    group_reference_tokenname: ts.group_reference_tokenname,
                    member_reference_tokenname: ts.member_reference_tokenname,
                    grace_expires_at: validFrom + groupDatum.grace_period_length,
                    grace_extensions_used: 0n,
                    rounds_paid: roundNumber + 1n,
                },
            }
            : {
                TreasuryState: {
                    ...ts,
                    rounds_paid: roundNumber + 1n,
                    is_deferred: false,
                },
            };
        return tx.pay.ToContract(
            treasuryAddress,
            { kind: "inline", value: Data.to(updatedDatum, TreasuryDatum) },
            { lovelace: outputLovelace, [memberToken]: 1n },
        );
    }, baseTxWithGroup);

    const tx = yield* withTreasuryOutputs
        .pay.ToAddress(borrowerAddress, { lovelace: payoutAmount })
        .validFrom(Number(validFrom))
        .completeProgram(lucid.config().network === "Custom" ? { localUPLCEval: false } : {})
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "distributeRound", error: String(e) })));

    return tx;
  });
