
import {
    Data,
    LucidEvolution,
    TxSignBuilder,
    RedeemerBuilder,
    Assets,
    toUnit
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
    TreasuryDatum,
    TreasuryDatumSchema,
    TreasuryRedeemer
} from "../core/types.js";
import { treasuryValidator, treasuryPolicyId, groupValidator, groupPolicyId, accountPolicyId } from "../core/validators/constants.js";
import { DcuError, InvalidDatumError, TransactionBuildError, UtxoNotFoundError } from "../core/errors.js";
import { getScriptAddress, getWalletAddress, parseSafeDatum, patchInlineDatum, assetNameLabels, resolveUtxoByUnit } from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for a member withdrawal from the Treasury.
 * 
 * **Functionality:**
 * - Allows a member to withdraw their allocated funds (loan/payout).
 * - Ensures remaining Treasury funds are preserved and returned to the script.
 * 
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Member Withdraw Configuration.
 * @returns Effect yielding TxSignBuilder.
 * 
 * @example
 * ```typescript
 * const program = unsignedMemberWithdrawTxProgram(lucid, 
 *   { groupUtxo, accountUtxo, treasuryUtxo, withdrawAmount }
 * );
 * ```
 */
export type MemberWithdrawConfig = {
    groupTokenSuffix: string;
    accountTokenSuffix: string;
    withdrawAmount: bigint;
};

export const unsignedMemberWithdrawTxProgram = (
  lucid: LucidEvolution,
  config: MemberWithdrawConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupTokenSuffix, accountTokenSuffix, withdrawAmount } = config;

    const groupRefUnit   = groupPolicyId!   + assetNameLabels.prefix100 + groupTokenSuffix;
    const accountUserUnit = accountPolicyId + assetNameLabels.prefix222 + accountTokenSuffix;

    const groupUtxoRaw   = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const accountUtxoRaw = yield* resolveUtxoByUnit(lucid, accountUserUnit);
    const groupUtxo   = patchInlineDatum(groupUtxoRaw);
    const accountUtxo = patchInlineDatum(accountUtxoRaw);

    const memberRefName    = assetNameLabels.prefix222 + accountTokenSuffix;
    const treasuryAddress  = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);
    const allTreasuryUtxos = yield* Effect.tryPromise({
        try: () => lucid.utxosAt(treasuryAddress),
        catch: (e) => new TransactionBuildError({ operation: "queryTreasury", error: String(e) }),
    });

    const treasuryUtxoRaw = yield* Effect.gen(function* () {
        for (const u of allTreasuryUtxos) {
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
    const treasuryUtxo = patchInlineDatum(treasuryUtxoRaw);
    const treasuryDatum = (yield* parseSafeDatum(treasuryUtxo.datum, TreasuryDatumSchema)) as unknown as TreasuryDatum;
    if (!('TreasuryState' in treasuryDatum)) return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Expected TreasuryState" }));

    const ts = treasuryDatum.TreasuryState;
    const memberToken = toUnit(treasuryPolicyId!, memberRefName);

    // Calculate remaining Treasury Balance
    const currentTreasuryBalance = treasuryUtxo.assets.lovelace;
    if (currentTreasuryBalance < withdrawAmount + 2_000_000n) {
         // Basic safety check: Ensure enough remains for min ADA
         return yield* Effect.fail(new TransactionBuildError({ operation: "memberWithdraw", error: "Insufficient funds in Treasury UTxO" }));
    }
    const remainingBalance = currentTreasuryBalance - withdrawAmount;

    // Use a single `now` for both the datum and validFrom — Aiken reads
    // get_lower_bound(tx) for the claimable_at comparison.
    const now = BigInt(Date.now());
    const updatedDatum: TreasuryDatum = {
        TreasuryState: {
            group_reference_tokenname: ts.group_reference_tokenname,
            member_reference_tokenname: ts.member_reference_tokenname,
            membership_start: ts.membership_start,
            assigned_slot: ts.assigned_slot,
            contribution_list: ts.contribution_list.filter(c => c.claimable_at > now),
            member_payment_credential: ts.member_payment_credential,
        }
    };

    const redeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => {
            return Data.to({
                MemberWithdraw: {
                    group_ref_input_index: 0n, // Only 1 ref input (groupUtxo) -> Index 0
                    member_input_index: inputIndices[0],
                    treasury_input_index: inputIndices[1],
                    treasury_output_index: 0n,
                    withdrawal_amount: withdrawAmount
                }
            }, TreasuryRedeemer);
        },
        inputs: [accountUtxo, treasuryUtxo]
    };

    const treasuryAssets: Assets = { lovelace: remainingBalance, [memberToken]: 1n };

    const address = yield* getWalletAddress(lucid);

    const tx = yield* lucid.newTx()
        .readFrom([groupUtxo])
        .collectFrom([accountUtxo])
        .collectFrom([treasuryUtxo], redeemer)
        .pay.ToContract(treasuryAddress, { kind: "inline", value: Data.to(updatedDatum, TreasuryDatum) }, treasuryAssets)
        .pay.ToAddress(address, { lovelace: withdrawAmount })
        .validFrom(Number(now))
        .attach.SpendingValidator(treasuryValidator.spendTreasury)
        .completeProgram({ localUPLCEval: false })
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "memberWithdraw", error: String(e) })));
    return tx;
  });
