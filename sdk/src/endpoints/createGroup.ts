import { Data, TxSignBuilder, fromText, LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum } from "../core/types.js";
import { DcuValidators } from "../core/validators/context.js";
import { buildGroupMintRedeemer, tryBuildTx } from "../core/utils.js";
import { DcuError, TransactionBuildError, ValidatorNotFoundError } from "../core/errors.js";

/**
 * Creates an unsigned transaction for creating a new Group.
 *
 * @param lucid - Lucid instance with wallet selected
 * @param config - Group configuration and fees
 * @param utxoToSpend - UTxO to spend for uniqueness
 * @param scripts - Validator scripts from DcuValidators
 * @returns Effect yielding a TxSignBuilder ready for signing
 *
 * @example
 * ```typescript
 * const tx = yield* unsignedCreateGroupTxProgram(
 *   lucid,
 *   { member_count: 0n, is_active: true, ... },
 *   selectedUtxo,
 *   scripts
 * );
 * ```
 */
export const unsignedCreateGroupTxProgram = (
  lucid: LucidEvolution,
  config: GroupDatum,
  utxoToSpend: UTxO, // Typed correctly
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const groupScripts = scripts.group;
    // PolicyID is on the Minting Policy
    const policyId = groupScripts.mint.policyId;
    if (!policyId) yield* Effect.fail(new ValidatorNotFoundError({ validatorName: "group.mint" }));

    const userAddress = yield* Effect.tryPromise({
        try: () => lucid.wallet().address(),
        catch: (error) => new TransactionBuildError({ operation: "getAddress", error: String(error) })
    });

    const datum = Data.to(config, GroupDatum);

    // Use redeemer util for type-safe construction
    const redeemer = buildGroupMintRedeemer.createGroup();

    const txWithPay = yield* tryBuildTx("createGroup", async () => lucid
        .newTx()
        .collectFrom([utxoToSpend])
        .attach.MintingPolicy(groupScripts.mint.script)
        .mintAssets(
            {
                [policyId + fromText("GroupReference")]: 1n,
                [policyId + fromText("GroupAdmin")]: 1n,
            },
            redeemer
        )
        .pay.ToContract(
            scripts.group.spend.address,
            { kind: "inline", value: datum },
            { [policyId + fromText("GroupReference")]: 1n }
        )
        .pay.ToAddress(userAddress, {
            [policyId + fromText("GroupAdmin")]: 1n
        })
        .complete({ changeAddress: await lucid.wallet().address() })
    );

    return txWithPay;
  });

