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
import { DcuValidators } from "../core/validators/context.js";
import { fromHex, toHex, tryBuildTx } from "../core/utils.js";
import { 
    DcuError, 
    InvalidDatumError, 
    UtxoNotFoundError, 
    TransactionBuildError 
} from "../core/errors.js";

/**
 * Creates an unsigned transaction for Joining a Group.
 * 
 * **Functionality:**
 * 1. **Mints Treasury Token:** `treasury-membership` (sent to Treasury Validator).
 * 2. **Locks Contribution:** Sends contribution amount + min ADA to Treasury.
 * 3. **Updates Group State:** Increments `member_count` (Assigns slot index).
 * 
 * @param lucid - Lucid instance with wallet selected.
 * @param groupUtxo - The Reference UTxO of the Group to join.
 * @param accountUtxo - The Account UTxO (Identity Proof).
 * @param adminUtxo - The Group Admin UTxO (Required to authorize Group State update).
 * @param contributionAmount - Amount in Lovelace to lock.
 * @param scripts - Validator Context.
 * @returns Effect yielding a TxSignBuilder.
 */
export const unsignedJoinGroupTxProgram = (
  lucid: LucidEvolution,
  groupUtxo: UTxO,
  accountUtxo: UTxO,
  adminUtxo: UTxO, // Required for UpdateGroup redeemer check
  contributionAmount: bigint, // Lovelace
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const groupDatum = Data.from(groupUtxo.datum!, GroupDatum);
    if (!groupDatum) yield* Effect.fail(new InvalidDatumError({ field: "groupDatum", reason: "Invalid Group Datum" }));

    const currentCount = groupDatum.member_count;
    const assignedSlot = currentCount; 
    const nextCount = currentCount + 1n;

    // 1. Prepare Updated Group Datum
    const updatedGroupDatum: GroupDatum = {
        ...groupDatum,
        member_count: nextCount
    };

    // 2. Prepare Treasury Datum
    const groupPolicy = scripts.group.mint.policyId;
    const groupRefAssetEntry = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicy));
    
    const groupRefName = groupRefAssetEntry 
        ? groupRefAssetEntry.slice(groupPolicy.length) 
        : fromText("GroupReference");

    const accountPolicy = scripts.account.mint.policyId;
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

    // 3. Redeemers (Using RedeemerBuilder)

    // Group Spending Redeemer (UpdateGroup)
    // Needs indices of: Group UTxO, Admin UTxO
    const groupRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => {
            // [groupUtxo, adminUtxo] -> [groupIndex, adminIndex]
            return Data.to({
                UpdateGroup: {
                    group_ref_token_name: groupRefName,
                    group_input_index: inputIndices[0],
                    admin_input_index: inputIndices[1],
                    group_output_index: 0n        // Output 0
                }
            }, GroupSpendRedeemer);
        },
        inputs: [groupUtxo, adminUtxo]
    };

    // Treasury Minting Redeemer (JoinGroup)
    // Needs indices of: Group UTxO, Account UTxO
    const treasuryRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => {
             // [groupUtxo, accountUtxo] -> [groupIndex, memberIndex]
             return Data.to({
                JoinGroup: {
                    group_ref_input_index: inputIndices[0],
                    member_input_index: inputIndices[1],
                    treasury_output_index: 1n     // Output 1
                }
             }, TreasuryRedeemer);
        },
        inputs: [groupUtxo, accountUtxo]
    };

    // 4. Build Tx
    const tx = yield* tryBuildTx("joinGroup", async () => {
        return lucid.newTx()
        .collectFrom([groupUtxo], groupRedeemer) // Attach builder for spending
        .collectFrom([accountUtxo])              // No redeemer needed (Pubkey)
        .collectFrom([adminUtxo])                // No redeemer needed (Pubkey)
        .mintAssets(
            { 
                [scripts.treasury.mint.policyId + accountAssetName]: 1n 
            },
            treasuryRedeemer // Attach builder for minting
        )
        .attach.MintingPolicy(scripts.treasury.mint.script)
        .attach.SpendingValidator(scripts.group.spend.script)
        
        // Output 0: Updated Group
        .pay.ToContract(
            scripts.group.spend.address,
            { kind: "inline", value: Data.to(updatedGroupDatum, GroupDatum) },
            groupUtxo.assets
        )
        
        // Output 1: Treasury Lock
        .pay.ToContract(
            scripts.treasury.spend.address,
            { kind: "inline", value: Data.to(treasuryDatum, TreasuryDatum) },
            { 
                lovelace: contributionAmount,
                [scripts.treasury.mint.policyId + accountAssetName]: 1n 
            }
        )
        // Output 2: Return Account NFT to User
        .pay.ToAddress(
            await lucid.wallet().address(), 
            accountUtxo.assets // Return all assets from the Account UTxO (The NFT)
        )
        .addSigner(await lucid.wallet().address())
        .complete();
    });

    return tx;
  });
