import { Data, TxSignBuilder, fromText, LucidEvolution, UTxO, Constr } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum } from "../core/types.js";
import { getScriptAddress, tryBuildTx } from "../core/utils/index.js";
import { DcuError, TransactionBuildError, ValidatorNotFoundError } from "../core/errors.js";
import { groupValidator, groupPolicyId } from "../core/validators/constants.js";

/**
 * Creates an unsigned transaction for creating a new DCU Group.
 *
 * **Functionality:**
 * - Mints a unique pair of Group tokens (Reference + Admin Auth).
 * - Locks the Reference NFT in the Group script with the provided configuration.
 * - Sends the Admin Auth NFT to the user's wallet.
 * - Initializes the Group Datum (Fees, Intervals, Inactive State).
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Initial Group Configuration.
 * @returns Effect yielding a TxSignBuilder ready for signing.
 *
 * @example
 * ```typescript
 * const tx = yield* unsignedCreateGroupTxProgram(
 *   lucid,
 *   { groupDatum, utxoToSpend }
 * );
 * ```
 */
export type CreateGroupConfig = {
    groupDatum: GroupDatum;
    utxoToSpend: UTxO;
};

export const unsignedCreateGroupTxProgram = (
  lucid: LucidEvolution,
  config: CreateGroupConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupDatum, utxoToSpend } = config;
    
    // PolicyID is on the Minting Policy
    if (!groupPolicyId) yield* Effect.fail(new ValidatorNotFoundError({ validatorName: "group.mint" }));

    const userAddress = yield* Effect.tryPromise({
        try: () => lucid.wallet().address(),
        catch: (error) => new TransactionBuildError({ operation: "getAddress", error: String(error) })
    });
    
    const groupAddress = yield* getScriptAddress(lucid, groupValidator.spendGroup);

    const datum = Data.to(groupDatum, GroupDatum);

    // Redeemer: CreateGroup (Variant 0)
    const redeemer = Data.to(new Constr(0, []));

    const txWithPay = yield* tryBuildTx("createGroup", async () => lucid
        .newTx()
        .collectFrom([utxoToSpend])
        .attach.MintingPolicy(groupValidator.mintGroup)
        .mintAssets(
            {
                [groupPolicyId + fromText("GroupReference")]: 1n,
                [groupPolicyId + fromText("GroupAdmin")]: 1n,
            },
            redeemer
        )
        .pay.ToContract(
            groupAddress,
            { kind: "inline", value: datum },
            { [groupPolicyId + fromText("GroupReference")]: 1n }
        )
        .pay.ToAddress(userAddress, {
            [groupPolicyId + fromText("GroupAdmin")]: 1n
        })
        .complete({ changeAddress: await lucid.wallet().address() })
    );

    return txWithPay;
  });

