import { Effect } from "effect";
import { LucidEvolution, Data, UTxO, TxHash, TxSignBuilder, fromText } from "@lucid-evolution/lucid";
import { unsignedCreateAccountTxProgram } from "../../src/endpoints/createAccount.js";
import { unsignedUpdateAccountTxProgram } from "../../src/endpoints/updateAccount.js";
import { unsignedDeleteAccountTxProgram } from "../../src/endpoints/deleteAccount.js";
import { AccountDatum } from "../../src/core/account.types.js";
import { LucidContext } from "../infra/lucidContext.js";
import { DcuValidators } from "../../src/core/validators/context.js";

// --- Types ---

export type CreateAccountResult = {
    txHash: string;
    accountConfig: AccountDatum;
};

export type UpdateAccountResult = {
    txHash: string;
};

export type DeleteAccountResult = {
    txHash: string;
};

// --- Actions ---

export const createAccountTestCase = (
    { lucid, users }: LucidContext,
    scripts: DcuValidators,
    datumOverride?: Partial<AccountDatum>
): Effect.Effect<CreateAccountResult, Error, never> => {
    return Effect.gen(function* () {
        // use user1 as the creator
        lucid.selectWallet.fromSeed(users.user1.seedPhrase);
        
        const address = yield* Effect.promise(() => lucid.wallet().address());
        const utxos = yield* Effect.promise(() => lucid.utxosAt(address));
        
        // Simple selection: take the first one. 
        const selectedUTxO = utxos[0];
        if (!selectedUTxO) throw new Error("No UTxOs found for user1");

        const accountConfig: AccountDatum = {
            email_hash: fromText("email_hash"),
            phone_hash: fromText("phone_hash"),
            ...datumOverride
        };

        const createAccountTx = yield* unsignedCreateAccountTxProgram(
            lucid,
            accountConfig,
            selectedUTxO,
            scripts
        );
        const signedTx = yield* Effect.promise(() => createAccountTx.sign.withWallet().complete());
        const txHash = yield* Effect.promise(() => signedTx.submit());

        return {
            txHash,
            accountConfig,
        };
    });
};

export const updateAccountTestCase = (
    context: LucidContext,
    accountUtxo: UTxO,
    userUtxo: UTxO,
    updatedDatum: AccountDatum,
    scripts: DcuValidators
): Effect.Effect<UpdateAccountResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;

        const updateAccountTx = yield* unsignedUpdateAccountTxProgram(
            lucid,
            accountUtxo,
            Data.to(updatedDatum, AccountDatum), // We need to pass Data, logic inside expects Config/Data
            userUtxo,
            scripts
        );
        const signedTx = yield* Effect.promise(() => updateAccountTx.sign.withWallet().complete());
        const updateAccountTxHash = yield* Effect.promise(() => signedTx.submit());

        return {
            txHash: updateAccountTxHash,
        };
    });
};

export const deleteAccountTestCase = (
    context: LucidContext,
    accountUtxo: UTxO,
    userUtxo: UTxO,
    scripts: DcuValidators
): Effect.Effect<DeleteAccountResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;

        const deleteAccountTx = yield* unsignedDeleteAccountTxProgram(
            lucid,
            accountUtxo,
            userUtxo,
            scripts
        );
        const signedTx = yield* Effect.promise(() => deleteAccountTx.sign.withWallet().complete());
        const deleteAccountTxHash = yield* Effect.promise(() => signedTx.submit());

        return {
            txHash: deleteAccountTxHash,
        };
    });
};
