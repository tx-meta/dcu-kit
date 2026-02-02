
import { LucidEvolution, Data, UTxO, TxHash, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { AccountDatum, AccountRedeemer } from "../core/types.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { tryBuildTx, getScriptAddress, createCip68TokenNames } from "../core/utils/index.js";
import { accountValidator, accountPolicyId } from "../core/validators/constants.js";

// --- Configuration ---

export type CreateAccountConfig = {
    selected_out_ref: UTxO;
    account_datum: AccountDatum;
};

// --- Endpoint ---

/**
 * Creates an unsigned transaction for creating a DCU Account.
 * 
 * **Functionality:**
 * - Mints a unique pair of CIP-68 tokens (Reference + User Auth).
 * - Locks the Reference NFT in the Account Script with the provided datum.
 * - Sends the User Auth NFT to the user's wallet.
 * - Initializes the Account Datum (Email Hash, Phone Hash) on-chain.
 * 
 * @param lucid - Lucid instance with wallet selected.
 * @param config - CreateAccountConfig (UTxO + Datum).
 * @returns Effect yielding TxSignBuilder.
 * 
 * @example
 * ```typescript
 * const program = unsignedCreateAccountTxProgram(lucid, {
 *   selected_out_ref: utxo,
 *   account_datum: { email_hash: "...", phone_hash: "..." }
 * });
 * ```
 */
export const unsignedCreateAccountTxProgram = (
  lucid: LucidEvolution,
  config: CreateAccountConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const address = yield* Effect.tryPromise({
        try: () => lucid.wallet().address(),
        catch: (error) => new TransactionBuildError({ operation: "getAddress", error: String(error) })
    });
    
    const accountScriptAddress = yield* getScriptAddress(lucid, accountValidator.spendAccount);
    const { refTokenName, userTokenName } = yield* createCip68TokenNames(config.selected_out_ref);
    
    const datum = Data.to(config.account_datum, AccountDatum);
    const redeemer = Data.to(
        { CreateAccount: { input_index: 0n, output_index: 0n } }, 
        AccountRedeemer
    );

    return yield* tryBuildTx("createAccount", async () => lucid
      .newTx()
      .collectFrom([config.selected_out_ref])
      .mintAssets(
        {
          [accountPolicyId + refTokenName]: 1n,
          [accountPolicyId + userTokenName]: 1n,
        },
        redeemer,
      )
      .pay.ToAddressWithData(
        accountScriptAddress,
        { kind: "inline", value: datum },
        { [accountPolicyId + refTokenName]: 1n },
      )
      .pay.ToAddress(address, {
        [accountPolicyId + userTokenName]: 1n
      })
      .attach.MintingPolicy(accountValidator.mintAccount)
      .addSigner(address)
      .complete()
    );
  });
