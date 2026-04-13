
import { LucidEvolution, Data, UTxO, TxSignBuilder, RedeemerBuilder } from "@lucid-evolution/lucid";
import { AccountDatum, AccountRedeemer } from "../core/types.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { getScriptAddress, createCip68TokenNames, getWalletAddress } from "../core/utils/index.js";
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
 * ```ts
import { createAccount } from "@dcu/sdk";

const program = createAccount(lucid, {
  selected_out_ref: utxo,
  account_datum: { 
     email_hash: "abcd...", 
     phone_hash: "1234..." 
  }
});
```
 */
export const unsignedCreateAccountTxProgram = (
  lucid: LucidEvolution,
  config: CreateAccountConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const address = yield* getWalletAddress(lucid);
    const accountScriptAddress = yield* getScriptAddress(lucid, accountValidator.spendAccount);
    const { refTokenName, userTokenName } = yield* createCip68TokenNames(config.selected_out_ref);

    const datum = Data.to(config.account_datum, AccountDatum);

    // RedeemerBuilder resolves the actual sorted index of selected_out_ref at build time.
    // The validator uses input_index to re-derive the CIP-68 names — it must point to
    // the same UTxO the SDK used to compute refTokenName/userTokenName.
    const redeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to(
            { CreateAccount: { input_index: inputIndices[0], output_index: 0n } },
            AccountRedeemer
        ),
        inputs: [config.selected_out_ref],
    };

    return yield* lucid
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
      .completeProgram()
      .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "createAccount", error: String(e) })));
  });
