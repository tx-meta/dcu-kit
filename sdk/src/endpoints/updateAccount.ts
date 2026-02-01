import { LucidEvolution, Data, UTxO, TxHash, fromText, TxSignBuilder, RedeemerBuilder } from "@lucid-evolution/lucid";
import { AccountRedeemer, AccountDatum } from "../core/types.js";
import { DcuValidators } from "../core/validators/context.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { tryBuildTx } from "../core/utils.js";

/**
 * Creates an unsigned transaction for Updating Account Information.
 * 
 * **Functionality:**
 * - Updates the Account Datum (Email/Phone Hash) on-chain.
 * - Requires authentication via `AccountUser` token (Input).
 * 
 * @param lucid - Lucid instance.
 * @param accountUtxo - Account Reference UTxO (at Script).
 * @param config - New Account Datum.
 * @param userUtxo - User Auth UTxO (at Wallet).
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedUpdateAccountTxProgram = (
  lucid: LucidEvolution,
  accountUtxo: UTxO,
  config: AccountDatum, 
  userUtxo: UTxO,
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const accountScripts = scripts.account;
    const policyId = accountScripts.mint.policyId;
    
    // Use RedeemerBuilder to handle indices
    const redeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => {
            // [userUtxo, accountUtxo] -> [userIndex, accountIndex]
            return Data.to(
              { UpdateAccount: { 
                  reference_token_name: fromText("AccountReference"),
                  user_input_index: inputIndices[0],
                  account_input_index: inputIndices[1],
                  account_output_index: 0n
              }},
              AccountRedeemer
            );
        },
        inputs: [userUtxo, accountUtxo]
    };

    const tx = yield* tryBuildTx("updateAccount", () => lucid
      .newTx()
      .collectFrom([accountUtxo], redeemer)
      .collectFrom([userUtxo])
      .attach.SpendingValidator(accountScripts.spend.script)
      .attach.MintingPolicy(accountScripts.mint.script) // Attach rule
      .pay.ToContract(
          accountScripts.spend.address,
          { kind: "inline", value: Data.to(config, AccountDatum) },
          { [policyId + fromText("AccountReference")]: 1n }
      )
      .complete()
    );

    return tx;
  });
