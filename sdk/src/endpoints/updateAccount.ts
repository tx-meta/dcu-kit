import { LucidEvolution, Data, UTxO, TxHash, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { AccountRedeemer } from "../core/account.types.js";
import { DcuValidators } from "../core/validators/context.js";
import { Effect } from "effect";

export const unsignedUpdateAccountTxProgram = (
  lucid: LucidEvolution,
  accountUtxo: UTxO,
  config: Data, 
  userUtxo: UTxO,
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, Error, never> =>
  Effect.gen(function* () {
    const accountScripts = scripts.account;
    const policyId = accountScripts.mint.policyId;
    
    const redeemer = Data.to(
      { UpdateAccount: { 
          reference_token_name: fromText("AccountReference"),
          user_input_index: 0n,
          account_input_index: 0n,
          account_output_index: 0n
      }},
      AccountRedeemer
    );

    const tx = yield* Effect.promise(() => lucid
      .newTx()
      .collectFrom([accountUtxo], redeemer)
      .collectFrom([userUtxo])
      .attach.SpendingValidator(accountScripts.spend.script)
      .attach.MintingPolicy(accountScripts.mint.script) // Attach rule
      .pay.ToContract(
          accountScripts.spend.address,
          { kind: "inline", value: Data.void() },
          { [policyId + fromText("AccountReference")]: 1n }
      )
      .complete());

    return tx;
  });
