import { LucidEvolution, Data, UTxO, TxHash, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { AccountDatum, AccountRedeemer } from "../core/account.types.js";
import { DcuValidators } from "../core/validators/context.js";
import { Effect } from "effect";

export const unsignedCreateAccountTxProgram = (
  lucid: LucidEvolution,
  config: AccountDatum,
  utxoToSpend: UTxO,
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, Error, never> =>
  Effect.gen(function* () {
    const accountScripts = scripts.account;
    const policyId = accountScripts.mint.policyId;
    
    const userAddress = yield* Effect.promise(async () => lucid.wallet().address());
    const network = lucid.config().network;
    
    const datum = Data.to(config, AccountDatum);

    const redeemer = Data.to(
      { CreateAccount: { input_index: 0n, output_index: 0n } },
      AccountRedeemer
    );

    const txWithPay = yield* Effect.promise(() => lucid
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
