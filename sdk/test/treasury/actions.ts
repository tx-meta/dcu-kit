
import { Effect } from "effect";
import { UTxO } from "@lucid-evolution/lucid";
import { 
    unsignedJoinGroupTxProgram, 
} from "../../src/endpoints/joinGroup.js";
import {
    unsignedDistributePayoutTxProgram
} from "../../src/endpoints/distributePayout.js";
import {
    unsignedMemberWithdrawTxProgram
} from "../../src/endpoints/memberWithdraw.js";
import {
    unsignedExitGroupTxProgram
} from "../../src/endpoints/exitGroup.js";
import { LucidContext } from "../infra/lucidContext.js";
import { DcuValidators } from "../../src/core/validators/context.js";
import { selectWalletFromSeed, signAndSubmit } from "../../src/core/index.js";

// --- Types ---

export type JoinGroupResult = {
    txHash: string;
};

export type DistributePayoutResult = {
    txHash: string;
};

export type MemberWithdrawResult = {
    txHash: string;
};

export type ExitGroupResult = {
    txHash: string;
};

// --- Test Cases ---

export const joinGroupTestCase = (
    context: LucidContext,
    groupUtxo: UTxO,
    accountUtxo: UTxO,
    adminUtxo: UTxO,
    contributionAmount: bigint,
    scripts: DcuValidators,
    userSeed: string // User joining
): Effect.Effect<JoinGroupResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;
        selectWalletFromSeed(lucid, userSeed);
        
        const joinTx = yield* unsignedJoinGroupTxProgram(
            lucid,
            groupUtxo,
            accountUtxo,
            adminUtxo,
            contributionAmount,
            scripts
        );
        const txHash = yield* signAndSubmit(joinTx);
        yield* Effect.promise(() => lucid.awaitTx(txHash));

        return { txHash };
    });
};

export const distributePayoutTestCase = (
    context: LucidContext,
    groupUtxo: UTxO,
    treasuryUtxos: UTxO[],
    scripts: DcuValidators,
    callerSeed: string 
): Effect.Effect<DistributePayoutResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;
        selectWalletFromSeed(lucid, callerSeed);

        const payoutTx = yield* unsignedDistributePayoutTxProgram(
            lucid,
            groupUtxo,
            treasuryUtxos,
            scripts
        );
        const txHash = yield* signAndSubmit(payoutTx);
        yield* Effect.promise(() => lucid.awaitTx(txHash));

        return { txHash };
    });
};

export const memberWithdrawTestCase = (
    context: LucidContext,
    groupUtxo: UTxO,
    accountUtxo: UTxO,
    treasuryUtxo: UTxO,
    withdrawAmount: bigint,
    scripts: DcuValidators,
    userSeed: string
): Effect.Effect<MemberWithdrawResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;
        selectWalletFromSeed(lucid, userSeed);
        
        const withdrawTx = yield* unsignedMemberWithdrawTxProgram(
            lucid,
            groupUtxo,
            accountUtxo,
            treasuryUtxo,
            withdrawAmount,
            scripts
        );
        const txHash = yield* signAndSubmit(withdrawTx);
        yield* Effect.promise(() => lucid.awaitTx(txHash));

        return { txHash };
    });
};

export const exitGroupTestCase = (
    context: LucidContext,
    groupUtxo: UTxO,
    accountUtxo: UTxO,
    treasuryUtxo: UTxO,
    scripts: DcuValidators,
    userSeed: string
): Effect.Effect<ExitGroupResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;
        selectWalletFromSeed(lucid, userSeed);
        
        const exitTx = yield* unsignedExitGroupTxProgram(
            lucid,
            groupUtxo,
            accountUtxo,
            treasuryUtxo,
            scripts
        );
        const txHash = yield* signAndSubmit(exitTx);
        yield* Effect.promise(() => lucid.awaitTx(txHash));

        return { txHash };
    });
};
