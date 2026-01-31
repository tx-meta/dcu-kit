
import { 
    Data, 
    LucidEvolution, 
    UTxO, 
    TxSignBuilder, 
    fromText 
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { 
    GroupDatum, 
    TreasuryDatum, 
    TreasuryRedeemer, 
    GroupSpendRedeemer 
} from "../core/types.js";
import { DcuValidators } from "../core/validators/context.js";
import { fromHex, toHex, sortUtxos, tryBuildTx } from "../core/utils.js";
import { 
    DcuError, 
    InvalidDatumError, 
    UtxoNotFoundError, 
    TransactionBuildError 
} from "../core/errors.js";

/**
 * Creates an unsigned transaction for Joining a Group.
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

    // 3. Sort Inputs and Calculate Indices
    // Dedup first (Account and Admin might be on same UTxO)
    const uniqueInputsMap = new Map<string, UTxO>();
    [groupUtxo, accountUtxo, adminUtxo].forEach(u => {
        uniqueInputsMap.set(u.txHash + u.outputIndex, u);
    });
    const uniqueInputs = Array.from(uniqueInputsMap.values());
    const allInputs = sortUtxos(uniqueInputs);
    
    const groupIndex = BigInt(allInputs.findIndex(u => u === groupUtxo));
    const memberIndex = BigInt(allInputs.findIndex(u => u === accountUtxo));
    const adminIndex = BigInt(allInputs.findIndex(u => u === adminUtxo));

    if (groupIndex < 0 || memberIndex < 0 || adminIndex < 0) {
        return yield* Effect.fail(new TransactionBuildError({ operation: "sortInputs", error: "Inputs lost during sort?" }));
    }
    
    // 4. Redeemers
    const groupRedeemer = Data.to({
        UpdateGroup: {
            group_ref_token_name: groupRefName,
            admin_input_index: adminIndex,
            group_input_index: groupIndex,
            group_output_index: 0n // Group output will be first
        }
    }, GroupSpendRedeemer);

    const treasuryRedeemer = Data.to({
        JoinGroup: {
            group_ref_input_index: groupIndex, // Group is spent (not reference)
            member_input_index: memberIndex,
            treasury_output_index: 1n // Treasury output is after Group
        }
    }, TreasuryRedeemer);

    // 5. Build Tx
    const tx = yield* tryBuildTx("joinGroup", async () => {
        const t = lucid.newTx();
        
        // Collect inputs (Group will have redeemer, others won't)
        for (const u of allInputs) {
            if (u === groupUtxo) {
                t.collectFrom([u], groupRedeemer);
            } else {
                t.collectFrom([u]);
            }
        }
        
        t.mintAssets(
            { 
                [scripts.treasury.mint.policyId + accountAssetName]: 1n 
            },
            treasuryRedeemer 
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
        .addSigner(await lucid.wallet().address());
        
        return t.complete();
    });

    return tx;
  });
