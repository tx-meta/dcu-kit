import {
    Data,
    LucidEvolution,
    UTxO,
    TxSignBuilder,
    RedeemerBuilder,
    paymentCredentialOf,
    Assets,
    toUnit
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
    GroupDatum,
    TreasuryDatum,
    TreasuryRedeemer,
    GroupSpendRedeemer,
    Contribution
} from "../core/types.js";
import { groupValidator, groupPolicyId } from "../core/validators/constants.js";
import { accountPolicyId } from "../core/validators/constants.js";
import { treasuryValidator, treasuryPolicyId } from "../core/validators/constants.js";
import { getScriptAddress, getWalletAddress, parseSafeDatum } from "../core/utils/index.js";
import {
    DcuError,
    UtxoNotFoundError,
    TransactionBuildError
} from "../core/errors.js";

/**
 * Creates an unsigned transaction for joining a Group.
 * 
 * **Functionality:**
 * - Mints a Treasury Membership NFT (unique to the Account).
 * - Locks the contribution amount (Lovelace) in the Treasury script.
 * - Updates the Group state (increments member count/assigns slot).
 * 
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Join Group Configuration.
 * @returns Effect yielding a TxSignBuilder.
 * 
 * @example
 * ```typescript
 * const program = unsignedJoinGroupTxProgram(lucid, 
 *   { groupUtxo, accountUtxo, adminUtxo, contributionAmount }
 * );
 * ```
 */
export type JoinGroupConfig = {
    groupUtxo: UTxO;
    accountUtxo: UTxO;
    contributionAmount: bigint;
    currentTime?: bigint; // POSIX ms — emulator.now() for emulator, Date.now() for live
};

export const unsignedJoinGroupTxProgram = (
  lucid: LucidEvolution,
  config: JoinGroupConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupUtxo, accountUtxo, contributionAmount, currentTime } = config;
    const groupDatum = yield* parseSafeDatum(groupUtxo.datum, GroupDatum);

    const assignedSlot = groupDatum.member_count; 
    const updatedGroupDatum: GroupDatum = {
        ...groupDatum,
        member_count: groupDatum.member_count + 1n
    };

    const groupRefAssetEntry = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicyId!));
    if (!groupRefAssetEntry) return yield* Effect.fail(new UtxoNotFoundError({ tokenName: "GroupReference (100)", address: groupUtxo.address }));
    const groupRefName = groupRefAssetEntry.slice(groupPolicyId!.length);

    const accountAssetEntry = Object.keys(accountUtxo.assets).find(k => k.startsWith(accountPolicyId!));
    if (!accountAssetEntry) return yield* Effect.fail(new UtxoNotFoundError({ tokenName: "Account NFT", address: accountUtxo.address }));
    const accountAssetName = accountAssetEntry.slice(accountPolicyId!.length); 
    // Pre-populate contribution schedule: one entry per interval, claimable at end of each period
    const contributionList: Contribution[] = Array.from(
        { length: Number(groupDatum.num_intervals) },
        (_, i) => ({
            claimable_at: groupDatum.start_time + BigInt(i + 1) * groupDatum.interval_length,
            claimable_amount: groupDatum.contribution_fee,
        })
    );

    const treasuryMemberToken = toUnit(treasuryPolicyId!, accountAssetName);

    const mintingAssets: Assets = { [treasuryMemberToken]: 1n };
    const treasuryAssets: Assets = { lovelace: contributionAmount, [treasuryMemberToken]: 1n };

    const address = yield* getWalletAddress(lucid);
    const memberPaymentCredential = paymentCredentialOf(address).hash;

    // Use a single `now` for both the datum and validFrom — Aiken checks
    // membership_start == get_lower_bound(tx), so they must match exactly.
    // Pass emulator.now() from the test layer when running on the emulator.
    const now = currentTime ?? BigInt(Date.now());

    const treasuryDatum: TreasuryDatum = {
        TreasuryState: {
            group_reference_tokenname: groupRefName,
            member_reference_tokenname: accountAssetName,
            membership_start: now,
            assigned_slot: assignedSlot,
            contribution_list: contributionList,
            member_payment_credential: memberPaymentCredential,
        }
    };

    const groupRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            MemberJoin: {
                group_ref_token_name: groupRefName,
                group_input_index: inputIndices[0],
                group_output_index: 0n
            }
        }, GroupSpendRedeemer),
        inputs: [groupUtxo]
    };

    const treasuryRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            JoinGroup: {
                group_ref_input_index: inputIndices[0],
                group_output_index: 0n,
                member_input_index: inputIndices[1],
                treasury_output_index: 1n
            }
        }, TreasuryRedeemer),
        inputs: [groupUtxo, accountUtxo]
    };

    const groupAddress = yield* getScriptAddress(lucid, groupValidator.spendGroup);
    const treasuryAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);

    const tx = yield* lucid
        .newTx()
        .collectFrom([groupUtxo], groupRedeemer)
        .collectFrom([accountUtxo])
        .mintAssets(mintingAssets, treasuryRedeemer)
        .pay.ToContract(groupAddress, { kind: "inline", value: Data.to(updatedGroupDatum, GroupDatum) }, groupUtxo.assets)
        .pay.ToContract(treasuryAddress, { kind: "inline", value: Data.to(treasuryDatum, TreasuryDatum) }, treasuryAssets)
        .pay.ToAddress(address, accountUtxo.assets)
        .addSigner(address)
        .validFrom(Number(now))
        .attach.MintingPolicy(treasuryValidator.mintTreasury)
        .attach.SpendingValidator(groupValidator.spendGroup)
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "joinGroup", error: String(e) })));
    return tx;
  });

