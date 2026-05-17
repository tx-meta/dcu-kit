
import {
    Data,
    LucidEvolution,
    TxSignBuilder,
    RedeemerBuilder,
    Assets,
    toUnit,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
    GroupDatum,
    GroupSpendRedeemer,
    TreasuryDatum,
    TreasuryDatumSchema,
    TreasuryRedeemer
} from "../core/types.js";
import { treasuryValidator, treasuryPolicyId, groupValidator, groupPolicyId, accountPolicyId } from "../core/validators/constants.js";
import { DcuError, InvalidDatumError, TransactionBuildError, UtxoNotFoundError } from "../core/errors.js";
import { getScriptAddress, getWalletAddress, parseSafeDatum, patchInlineDatum, assetNameLabels, resolveUtxoByUnit } from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for exiting a Group.
 *
 * **Functionality:**
 * - Spends the Group UTxO to decrement the member count.
 * - Handles both early and mature exits from a Group.
 * - Early Exit: Transition to Penalty State (fee deduction).
 * - Mature Exit: Burn Membership token and receive full refund.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Exit Group Configuration.
 * @returns Effect yielding TxSignBuilder.
 *
 * @example
 * ```typescript
 * const program = unsignedExitGroupTxProgram(lucid,
 *   { groupUtxo, accountUtxo, treasuryUtxo }
 * );
 * ```
 */
export type ExitGroupConfig = {
    groupTokenSuffix: string;
    accountTokenSuffix: string;
};

export const unsignedExitGroupTxProgram = (
  lucid: LucidEvolution,
  config: ExitGroupConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupTokenSuffix, accountTokenSuffix } = config;

    const groupRefUnit    = groupPolicyId!   + assetNameLabels.prefix100 + groupTokenSuffix;
    const accountUserUnit = accountPolicyId  + assetNameLabels.prefix222 + accountTokenSuffix;

    const groupUtxoRaw   = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const accountUtxoRaw = yield* resolveUtxoByUnit(lucid, accountUserUnit);
    const groupUtxo   = patchInlineDatum(groupUtxoRaw);
    const accountUtxo = patchInlineDatum(accountUtxoRaw);

    // Find treasury UTxO by scanning for a TreasuryState with matching member token
    const memberRefName   = assetNameLabels.prefix222 + accountTokenSuffix;
    const treasuryAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);
    const allTreasury     = yield* Effect.tryPromise({
        try: () => lucid.utxosAt(treasuryAddress),
        catch: (e) => new TransactionBuildError({ operation: "queryTreasury", error: String(e) }),
    });

    const treasuryUtxoRaw = yield* Effect.gen(function* () {
        for (const u of allTreasury) {
            const parsed = yield* parseSafeDatum(u.datum, TreasuryDatumSchema).pipe(
                Effect.map(d => d as unknown as TreasuryDatum),
                Effect.orElse(() => Effect.succeed(null)),
            );
            if (parsed && 'TreasuryState' in parsed && parsed.TreasuryState.member_reference_tokenname === memberRefName) {
                return u;
            }
        }
        return yield* Effect.fail(new UtxoNotFoundError({ tokenName: memberRefName, address: treasuryAddress }));
    });
    const treasuryUtxo  = patchInlineDatum(treasuryUtxoRaw);
    const treasuryDatum = (yield* parseSafeDatum(treasuryUtxo.datum, TreasuryDatumSchema)) as unknown as TreasuryDatum;
    if (!('TreasuryState' in treasuryDatum)) return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Expected TreasuryState" }));

    const groupDatum = yield* parseSafeDatum(groupUtxo.datum, GroupDatum);

    const groupRefAssetEntry = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicyId!));
    if (!groupRefAssetEntry) return yield* Effect.fail(new UtxoNotFoundError({ tokenName: "GroupReference (100)", address: groupUtxo.address }));
    const groupRefName = groupRefAssetEntry.slice(groupPolicyId!.length);

    const memberToken = toUnit(treasuryPolicyId!, memberRefName);
    const penaltyAssets: Assets = { lovelace: 2_000_000n + groupDatum.penalty_fee, [memberToken]: 1n };
    const burnAssets: Assets = { [memberToken]: -1n };

    // Use a single `now` for isEarlyExit AND validFrom — Aiken computes is_early_exit
    // using get_lower_bound(tx), so the two must agree at the maturity boundary.
    const now = BigInt(Date.now());
    const maturityTime = groupDatum.start_time + (groupDatum.num_intervals * groupDatum.interval_length);
    const isEarlyExit = groupDatum.is_active && (now < maturityTime);

    // Updated Group datum: decrement member count on exit
    const updatedGroupDatum: GroupDatum = {
        ...groupDatum,
        member_count: groupDatum.member_count - 1n
    };

    // Group validator redeemer: MemberExit (no admin required)
    const groupRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            MemberExit: {
                group_ref_token_name: groupRefName,
                group_input_index: inputIndices[0],
                group_output_index: 0n
            }
        }, GroupSpendRedeemer),
        inputs: [groupUtxo]
    };

    // Treasury validator spend redeemer: ExitGroup
    // Output layout: [0] Group UTxO, [1] Penalty (early exit only)
    const treasurySpendRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            ExitGroup: {
                group_ref_input_index: inputIndices[0],
                group_output_index: 0n,
                member_input_index: inputIndices[1],
                treasury_input_index: inputIndices[2],
                penalty_output_index: isEarlyExit ? 1n : 0n
            }
        }, TreasuryRedeemer),
        inputs: [groupUtxo, accountUtxo, treasuryUtxo]
    };

    // Mint redeemer for mature exit burn — the mint handler (ExitGroup branch) calls
    // validate_terminate_group which ignores all index fields; any valid ExitGroup
    // redeemer works here. Using a plain Data value avoids sharing a RedeemerBuilder
    // between spend and mint contexts, which can cause index resolution issues in Lucid.
    const mintBurnRedeemer = Data.to({
        ExitGroup: {
            group_ref_input_index: 0n,
            group_output_index: 0n,
            member_input_index: 0n,
            treasury_input_index: 0n,
            penalty_output_index: 0n
        }
    }, TreasuryRedeemer);

    const address = yield* getWalletAddress(lucid);
    const groupAddress = yield* getScriptAddress(lucid, groupValidator.spendGroup);

    const penaltyDatum: TreasuryDatum = {
        PenaltyState: {
            group_reference_tokenname: treasuryDatum.TreasuryState.group_reference_tokenname,
            member_reference_tokenname: treasuryDatum.TreasuryState.member_reference_tokenname
        }
    };

    const baseTx = lucid.newTx()
        .collectFrom([groupUtxo], groupRedeemer)
        .collectFrom([accountUtxo])
        .collectFrom([treasuryUtxo], treasurySpendRedeemer)
        .addSigner(address)
        .pay.ToContract(groupAddress, { kind: "inline", value: Data.to(updatedGroupDatum, GroupDatum) }, groupUtxo.assets);

    const tx = yield* (isEarlyExit
        ? baseTx.pay.ToContract(treasuryAddress, { kind: "inline", value: Data.to(penaltyDatum, TreasuryDatum) }, penaltyAssets)
        : baseTx.mintAssets(burnAssets, mintBurnRedeemer))
        .validFrom(Number(now))
        .attach.MintingPolicy(treasuryValidator.mintTreasury)
        .attach.SpendingValidator(treasuryValidator.spendTreasury)
        .attach.SpendingValidator(groupValidator.spendGroup)
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "exitGroup", error: String(e) })));
    return tx;
  });
