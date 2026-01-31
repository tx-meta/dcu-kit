import { Effect } from "effect";
import { LucidEvolution, Data, UTxO, TxHash, TxSignBuilder, fromText } from "@lucid-evolution/lucid";
import { unsignedCreateAccountTxProgram } from "../../src/endpoints/createAccount.js";
import { unsignedUpdateAccountTxProgram } from "../../src/endpoints/updateAccount.js";
import { unsignedDeleteAccountTxProgram } from "../../src/endpoints/deleteAccount.js";
import { AccountDatum } from "../../src/core/types.js";
import { LucidContext } from "../infra/lucidContext.js";
import { DcuValidators } from "../../src/core/validators/context.js";
import { selectWalletFromSeed, getWalletAddress, getUtxosAt, signAndSubmit } from "../../src/core/index.js";
import { createDefaultAccountDatum } from "../helpers/index.js";

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
        // Use user1 as the creator
        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        
        const address = yield* getWalletAddress(lucid);
        const utxos = yield* getUtxosAt(lucid, address);
        
        // Simple selection: take the first one
        const selectedUTxO = utxos[0];
        if (!selectedUTxO) throw new Error("No UTxOs found for user1");

        const accountConfig = createDefaultAccountDatum(datumOverride);

        const createAccountTx = yield* unsignedCreateAccountTxProgram(
            lucid,
            accountConfig,
            selectedUTxO,
            scripts
        );
        const txHash = yield* signAndSubmit(createAccountTx);
        yield* Effect.promise(() => lucid.awaitTx(txHash));

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
            Data.to(updatedDatum, AccountDatum),
            userUtxo,
            scripts
        );
        const txHash = yield* signAndSubmit(updateAccountTx);
        yield* Effect.promise(() => lucid.awaitTx(txHash));

        return {
            txHash,
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
        const txHash = yield* signAndSubmit(deleteAccountTx);
        yield* Effect.promise(() => lucid.awaitTx(txHash));

        return {
            txHash,
        };
    });
};
