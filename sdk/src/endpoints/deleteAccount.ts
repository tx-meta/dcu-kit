import { LucidEvolution, Data, UTxO, TxHash, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { DcuValidators } from "../core/validators/context.js";
import { AccountRedeemer } from "../core/account.types.js";
import { Effect } from "effect";

export const unsignedDeleteAccountTxProgram = (
  lucid: LucidEvolution,
  accountUtxo: UTxO,
  userUtxo: UTxO,
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, Error, never> =>
  Effect.gen(function* () {
    const accountScripts = scripts.account;
    const policyId = accountScripts.mint.policyId;

    const redeemer = Data.to(
      { DeleteAccount: { 
          reference_token_name: fromText("AccountReference") 
      }},
      AccountRedeemer
    );

    const tx = yield* Effect.promise(() => lucid
      .newTx()
      .collectFrom([accountUtxo], redeemer)
      .collectFrom([userUtxo])
      .attach.SpendingValidator(accountScripts.spend.script)
      .attach.MintingPolicy(accountScripts.mint.script)
      .mintAssets(
          {
              [policyId + fromText("AccountReference")]: -1n,
              [policyId + fromText("AccountUser")]: -1n,
          },
          redeemer
      )
      .complete());

    return tx;
  });
