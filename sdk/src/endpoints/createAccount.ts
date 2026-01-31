import { LucidEvolution, Data, UTxO, TxHash, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { AccountDatum, AccountRedeemer } from "../core/types.js";
import { DcuValidators } from "../core/validators/context.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { tryBuildTx } from "../core/utils.js";

/**
 * Creates an unsigned transaction for Creating a DCU Account.
 * 
 * **Functionality:**
 * 1. Mints two tokens:
 *    - `AccountReference`: Sent to the Account Validator Script (holds Identity Datum).
 *    - `AccountUser`: Sent to the User's Wallet (Proof of Identity).
 * 2. Initializes the Account Datum (Email Hash, Phone Hash) on-chain.
 * 
 * @param lucid - Lucid instance.
 * @param config - Account Datum (e.g., Email Hash, Phone Hash).
 * @param utxoToSpend - Wallet UTxO to spend (for uniqueness/fees).
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedCreateAccountTxProgram = (
  lucid: LucidEvolution,
  config: AccountDatum,
  utxoToSpend: UTxO,
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const accountScripts = scripts.account;
    const policyId = accountScripts.mint.policyId;
    
    const userAddress = yield* Effect.tryPromise({
        try: () => lucid.wallet().address(),
        catch: (error) => new TransactionBuildError({ operation: "getAddress", error: String(error) })
    });
    const network = lucid.config().network;
    
    const datum = Data.to(config, AccountDatum);

    const redeemer = Data.to(
      { CreateAccount: { input_index: 0n, output_index: 0n } },
      AccountRedeemer
    );

    const txWithPay = yield* tryBuildTx("createAccount", () => lucid
        .newTx()
        .collectFrom([utxoToSpend])
        .attach.MintingPolicy(accountScripts.mint.script) // Use script from context
        .mintAssets(
            {
                [policyId + fromText("AccountReference")]: 1n,
                [policyId + fromText("AccountUser")]: 1n,
            },
            redeemer
        )
        .pay.ToContract(
            accountScripts.spend.address, // Use pre-calculated spend address
            { kind: "inline", value: datum },
            { 
                [policyId + fromText("AccountReference")]: 1n 
            }
        )
        .pay.ToAddress(userAddress, {
            [policyId + fromText("AccountUser")]: 1n
        })
        .complete()
    );

    return txWithPay;
  });
