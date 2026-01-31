import { Effect } from "effect";
import { Data, UTxO, fromText } from "@lucid-evolution/lucid";
import { unsignedCreateGroupTxProgram } from "../../src/endpoints/createGroup.js";
import { unsignedUpdateGroupTxProgram } from "../../src/endpoints/updateGroup.js";
import { unsignedDeleteGroupTxProgram } from "../../src/endpoints/deleteGroup.js";
import { GroupDatum } from "../../src/core/types.js";
import { LucidContext } from "../infra/lucidContext.js";
import { DcuValidators } from "../../src/core/validators/context.js";
import { selectWalletFromSeed, getWalletUtxos, signAndSubmit } from "../../src/core/index.js";
import { createDefaultGroupDatum } from "../helpers/index.js";

// --- Types ---

export type CreateGroupResult = {
    txHash: string;
    groupDatum: GroupDatum;
};

export type UpdateGroupResult = {
    txHash: string;
};

export type DeleteGroupResult = {
    txHash: string;
};

// --- Test Cases ---

export const createGroupTestCase = (
    { lucid, users }: LucidContext,
    scripts: DcuValidators,
    datumOverride?: Partial<GroupDatum>
): Effect.Effect<CreateGroupResult, Error, never> => {
    return Effect.gen(function* () {
        // Use user1 as the creator
        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        
        const utxos = yield* getWalletUtxos(lucid);
        const selectedUTxO = utxos[0];
        if (!selectedUTxO) throw new Error("No UTxOs found for user1");

        const groupDatum = createDefaultGroupDatum(datumOverride);

        const createGroupTx = yield* unsignedCreateGroupTxProgram(
            lucid,
            groupDatum,
            selectedUTxO,
            scripts
        );
        const txHash = yield* signAndSubmit(createGroupTx);
        yield* Effect.promise(() => lucid.awaitTx(txHash));

        return {
            txHash,
            groupDatum,
        };
    });
};

export const updateGroupTestCase = (
    context: LucidContext,
    groupUtxo: UTxO,
    updatedDatum: GroupDatum,
    adminUtxo: UTxO,
    scripts: DcuValidators
): Effect.Effect<UpdateGroupResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;

        const updateGroupTx = yield* unsignedUpdateGroupTxProgram(
            lucid,
            groupUtxo,
            updatedDatum,
            adminUtxo,
            scripts
        );
        const txHash = yield* signAndSubmit(updateGroupTx);
        yield* Effect.promise(() => lucid.awaitTx(txHash));

        return {
            txHash,
        };
    });
};

export const deleteGroupTestCase = (
    context: LucidContext,
    groupUtxo: UTxO,
    currentDatum: GroupDatum,
    adminUtxo: UTxO,
    scripts: DcuValidators
): Effect.Effect<DeleteGroupResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;

        const deleteGroupTx = yield* unsignedDeleteGroupTxProgram(
            lucid,
            groupUtxo,
            currentDatum,
            adminUtxo,
            scripts
        );
        const txHash = yield* signAndSubmit(deleteGroupTx);
        yield* Effect.promise(() => lucid.awaitTx(txHash));

        return {
            txHash,
        };
    });
};
