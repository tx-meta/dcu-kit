
import { LucidEvolution, Data, OutRef, TxSignBuilder, RedeemerBuilder, Assets, toUnit } from "@lucid-evolution/lucid";
import { AccountDatum, AccountRedeemer } from "../core/types.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { getScriptAddress, createCip68TokenNames, getWalletAddress, resolveUtxoByOutRef } from "../core/utils/index.js";
import { accountValidator, accountPolicyId } from "../core/validators/constants.js";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

// --- Configuration ---

export type CreateAccountConfig = {
    selected_out_ref: OutRef;
    email: string;
    phone: string;
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
    const selectedUtxo = yield* resolveUtxoByOutRef(lucid, config.selected_out_ref);
    const { refTokenName, userTokenName } = yield* createCip68TokenNames(selectedUtxo);

    const accountDatum: AccountDatum = {
      email_hash: bytesToHex(sha256(utf8ToBytes(config.email))),
      phone_hash: bytesToHex(sha256(utf8ToBytes(config.phone))),
    };
    const datum = Data.to(accountDatum, AccountDatum);

    const refToken = toUnit(accountPolicyId, refTokenName);
    const userToken = toUnit(accountPolicyId, userTokenName);

    const mintingAssets: Assets = { [refToken]: 1n, [userToken]: 1n };
    const scriptAssets: Assets = { [refToken]: 1n };
    const walletAssets: Assets = { [userToken]: 1n };

    // RedeemerBuilder resolves the actual sorted index of selected_out_ref at build time.
    // The validator uses input_index to re-derive the CIP-68 names — it must point to
    // the same UTxO the SDK used to compute refTokenName/userTokenName.
    const redeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to(
            { CreateAccount: { input_index: inputIndices[0], output_index: 0n } },
            AccountRedeemer
        ),
        inputs: [selectedUtxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([selectedUtxo])
      .mintAssets(mintingAssets, redeemer)
      .pay.ToAddressWithData(accountScriptAddress, { kind: "inline", value: datum }, scriptAssets)
      .pay.ToAddress(address, walletAssets)
      .addSigner(address)
      .attach.MintingPolicy(accountValidator.mintAccount)
      .completeProgram()
      .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "createAccount", error: String(e) })));
    return tx;
  });
