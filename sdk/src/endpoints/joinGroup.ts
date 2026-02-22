import { 
    Data, 
    LucidEvolution, 
    UTxO, 
    TxSignBuilder, 
    fromText,
    RedeemerBuilder
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { 
    GroupDatum, 
    TreasuryDatum, 
    TreasuryRedeemer, 
    GroupSpendRedeemer 
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
    adminUtxo: UTxO;
    contributionAmount: bigint;
};

export const unsignedJoinGroupTxProgram = (
  lucid: LucidEvolution,
  config: JoinGroupConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupUtxo, accountUtxo, adminUtxo, contributionAmount } = config;
    const groupDatum = yield* parseSafeDatum(groupUtxo.datum, GroupDatum);

    const assignedSlot = groupDatum.member_count; 
    const updatedGroupDatum: GroupDatum = {
        ...groupDatum,
        member_count: groupDatum.member_count + 1n
    };

    const groupPolicy = groupPolicyId!;
    const groupRefAssetEntry = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicy));
    const groupRefName = groupRefAssetEntry 
        ? groupRefAssetEntry.slice(groupPolicy.length) 
        : fromText("GroupReference");

    const accountPolicy = accountPolicyId!;
    const accountAssetEntry = Object.keys(accountUtxo.assets).find(k => k.startsWith(accountPolicy));
    if (!accountAssetEntry) return yield* Effect.fail(new UtxoNotFoundError({ tokenName: "Account NFT", address: accountUtxo.address }));
    
    const accountAssetName = accountAssetEntry.slice(accountPolicy.length); 
    const treasuryDatum: TreasuryDatum = {
        TreasuryState: {
            group_reference_tokenname: groupRefName, 
            member_reference_tokenname: accountAssetName, 
            membership_start: BigInt(Date.now()),
            assigned_slot: assignedSlot,
            slot_number: 0n,
            contribution_list: []
        }
    };

    const groupRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            UpdateGroup: {
                group_ref_token_name: groupRefName,
                group_input_index: inputIndices[0],
                admin_input_index: inputIndices[1],
                group_output_index: 0n
            }
        }, GroupSpendRedeemer),
        inputs: [groupUtxo, adminUtxo]
    };

    const treasuryRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            JoinGroup: {
                group_ref_input_index: inputIndices[0],
                member_input_index: inputIndices[1],
                treasury_output_index: 1n
            }
        }, TreasuryRedeemer),
        inputs: [groupUtxo, accountUtxo]
    };

    const address = yield* getWalletAddress(lucid);
    const groupAddress = yield* getScriptAddress(lucid, groupValidator.spendGroup);
    const treasuryAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);

    return yield* lucid
        .newTx()
        .collectFrom([groupUtxo], groupRedeemer)
        .collectFrom([accountUtxo])
        .collectFrom([adminUtxo])
        .mintAssets(
            { [treasuryPolicyId + accountAssetName]: 1n },
            treasuryRedeemer
        )
        .attach.MintingPolicy(treasuryValidator.mintTreasury)
        .attach.SpendingValidator(groupValidator.spendGroup)
        .pay.ToContract(
            groupAddress,
            { kind: "inline", value: Data.to(updatedGroupDatum, GroupDatum) },
            groupUtxo.assets
        )
        .pay.ToContract(
            treasuryAddress,
            { kind: "inline", value: Data.to(treasuryDatum, TreasuryDatum) },
            {
                lovelace: contributionAmount,
                [treasuryPolicyId + accountAssetName]: 1n
            }
        )
        .pay.ToAddress(address, accountUtxo.assets)
        .addSigner(address)
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "joinGroup", error: String(e) })));
  });

