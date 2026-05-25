
import {
    Data,
    LucidEvolution,
    TxSignBuilder,
    RedeemerBuilder,
    UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
    GroupDatum,
    GroupSpendRedeemer,
    TreasuryDatum,
    TreasuryDatumSchema,
    TreasuryRedeemer,
} from "../core/types.js";
import { treasuryValidator, treasuryPolicyId, groupPolicyId, groupValidator } from "../core/validators/constants.js";
import { getScriptAddress, getWalletAddress, parseSafeDatum, patchInlineDatum, assetNameLabels, resolveUtxoByUnit } from "../core/utils/index.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";

/**
 * Creates an unsigned transaction for resetting a mature ROSCA group to a new cycle.
 *
 * **Functionality:**
 * - Requires all rounds to have been distributed (last_distributed_round + 1 == num_intervals).
 * - Resets GroupDatum: is_started=false, last_distributed_round=-1, num_intervals=0, start_time=0.
 * - Resets all active TreasuryState UTxOs: rounds_paid=0, is_deferred=false.
 * - Members remain in the group at their existing slots.
 * - After nextCycle: members re-deposit via contribute, then admin calls startGroup.
 *
 * @param lucid - Lucid instance with admin wallet selected.
 * @param config - NextCycle Configuration.
 * @returns Effect yielding TxSignBuilder.
 */
export type NextCycleConfig = {
    groupTokenSuffix: string;
    // Reference script UTxOs (from deploy-scripts). Keeps tx well under 16KB.
    scriptRefs?: {
        treasury?: UTxO;
        group?: UTxO;
    };
};

export const unsignedNextCycleTxProgram = (
  lucid: LucidEvolution,
  config: NextCycleConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupTokenSuffix } = config;

    const groupRefUnit  = groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUserUnit = groupPolicyId! + assetNameLabels.prefix222 + groupTokenSuffix;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const adminUtxoRaw = yield* resolveUtxoByUnit(lucid, groupUserUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const adminUtxo = patchInlineDatum(adminUtxoRaw);

    const groupDatum = yield* parseSafeDatum(groupUtxo.datum, GroupDatum);

    if (!groupDatum.is_started) {
        return yield* Effect.fail(new TransactionBuildError({
            operation: "nextCycle",
            error: "Group has not been started — call startGroup first",
        }));
    }
    if (!groupDatum.is_active) {
        return yield* Effect.fail(new TransactionBuildError({
            operation: "nextCycle",
            error: "Group is deactivated — cannot start a new cycle",
        }));
    }
    if (groupDatum.last_distributed_round + 1n !== groupDatum.num_intervals) {
        const remaining = groupDatum.num_intervals - (groupDatum.last_distributed_round + 1n);
        return yield* Effect.fail(new TransactionBuildError({
            operation: "nextCycle",
            error: `${remaining} round(s) still pending — distribute all rounds before starting a new cycle`,
        }));
    }

    const groupRefAsset = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicyId!));
    if (!groupRefAsset) return yield* Effect.fail(new TransactionBuildError({ operation: "nextCycle", error: "Group reference token not found" }));
    const groupRefName = groupRefAsset.slice(groupPolicyId!.length);

    // Query all treasury UTxOs and filter to active members of this group at end-of-cycle.
    const treasuryAddress  = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);
    const groupAddress     = yield* getScriptAddress(lucid, groupValidator.spendGroup);
    const adminAddress     = yield* getWalletAddress(lucid);

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

    // Include only TreasuryState UTxOs belonging to this group where rounds_paid == num_intervals.
    // ICS and PenaltyState UTxOs are excluded — admin must resolve those before starting next cycle.
    const memberStates: { utxo: UTxO; datum: TreasuryDatum }[] = [];
    for (const state of parsedStates) {
        if (!state || !("TreasuryState" in state.datum)) continue;
        const ts = state.datum.TreasuryState;
        if (ts.group_reference_tokenname !== groupRefName) continue;
        if (ts.rounds_paid !== groupDatum.num_intervals) continue;
        memberStates.push(state);
    }

    if (memberStates.length === 0) {
        return yield* Effect.fail(new TransactionBuildError({
            operation: "nextCycle",
            error: "No treasury UTxOs found at end-of-cycle state. Are all rounds distributed?",
        }));
    }

    // Sort inputs lexicographically (matches Cardano's tx.inputs ordering).
    memberStates.sort((a, b) => {
        const cmp = a.utxo.txHash.localeCompare(b.utxo.txHash);
        return cmp !== 0 ? cmp : a.utxo.outputIndex - b.utxo.outputIndex;
    });

    // Reset group datum: clear cycle state, preserve membership and parameters.
    const updatedGroupDatum: GroupDatum = {
        ...groupDatum,
        is_started: false,
        last_distributed_round: -1n,
        num_intervals: 0n,
        start_time: 0n,
    };

    // Reset each treasury datum: clear rounds_paid and is_deferred, preserve everything else.
    // Build alongside the member token unit so both are available in the output loop.
    const resetEntries = memberStates.map(state => {
        if (!("TreasuryState" in state.datum)) throw new Error("invariant: non-TreasuryState after filter");
        const ts = state.datum.TreasuryState;
        const updatedDatum: TreasuryDatum = {
            TreasuryState: { ...ts, rounds_paid: 0n, is_deferred: false },
        };
        const memberToken = treasuryPolicyId! + ts.member_reference_tokenname;
        return { utxo: state.utxo, updatedDatum, memberToken };
    });

    // Output layout: [0] group, [1..n] treasury outputs
    const allInputs = [adminUtxo, groupUtxo, ...resetEntries.map(e => e.utxo)];

    const groupRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (indices: bigint[]) => Data.to({
            NextCycle: {
                group_ref_token_name: groupRefName,
                admin_input_index: indices[0],
                group_input_index: indices[1],
                group_output_index: 0n,
            }
        }, GroupSpendRedeemer),
        inputs: [adminUtxo, groupUtxo],
    };

    const treasuryRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (indices: bigint[]) => {
            // indices[0] = admin, indices[1] = group, indices[2..] = treasury inputs
            const treasuryIndices = indices.slice(2);
            const treasuryOutIndices = treasuryIndices.map((_, i) => BigInt(i + 1));
            return Data.to({
                NextCycle: {
                    group_input_index: indices[1],
                    group_output_index: 0n,
                    treasury_input_indices: treasuryIndices,
                    treasury_output_indices: treasuryOutIndices,
                }
            }, TreasuryRedeemer);
        },
        inputs: allInputs,
    };

    const baseTxNoValidators = lucid.newTx()
        .collectFrom([adminUtxo])
        .collectFrom([groupUtxo], groupRedeemer)
        .collectFrom(resetEntries.map(e => e.utxo), treasuryRedeemer);

    const baseTx = (config.scriptRefs?.treasury || config.scriptRefs?.group)
        ? baseTxNoValidators.readFrom(
              [config.scriptRefs?.treasury, config.scriptRefs?.group].filter(Boolean) as UTxO[]
          )
        : baseTxNoValidators
              .attach.SpendingValidator(groupValidator.spendGroup)
              .attach.SpendingValidator(treasuryValidator.spendTreasury);

    // Output 0: group (reset). Outputs 1..n: treasury UTxOs (reset, ADA preserved).
    const withGroupOutput = baseTx.pay.ToContract(
        groupAddress,
        { kind: "inline", value: Data.to(updatedGroupDatum, GroupDatum) },
        groupUtxo.assets,
    );

    const withAllOutputs = resetEntries.reduce((tx, entry) =>
        tx.pay.ToContract(
            treasuryAddress,
            { kind: "inline", value: Data.to(entry.updatedDatum, TreasuryDatum) },
            { lovelace: entry.utxo.assets.lovelace, [entry.memberToken]: 1n },
        )
    , withGroupOutput);

    const tx = yield* withAllOutputs
        .pay.ToAddress(adminAddress, { [groupUserUnit]: 1n })
        .addSigner(adminAddress)
        .completeProgram(lucid.config().network === "Custom" ? { localUPLCEval: false } : {})
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "nextCycle", error: String(e) })));

    return tx;
  });
