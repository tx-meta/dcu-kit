import { Effect } from "effect";
import {
  LucidEvolution,
  UTxO,
  fromText,
} from "@lucid-evolution/lucid";
import { unsignedCreateAccountTxProgram } from "../src/endpoints/createAccount.js";
import { unsignedUpdateAccountTxProgram } from "../src/endpoints/updateAccount.js";
import { unsignedDeleteAccountTxProgram } from "../src/endpoints/deleteAccount.js";
import { unsignedCreateGroupTxProgram } from "../src/endpoints/createGroup.js";
import { unsignedUpdateGroupTxProgram } from "../src/endpoints/updateGroup.js";
import { unsignedDeleteGroupTxProgram } from "../src/endpoints/deleteGroup.js";
import { unsignedJoinGroupTxProgram } from "../src/endpoints/joinGroup.js";
import { unsignedDistributePayoutTxProgram } from "../src/endpoints/distributePayout.js";
import { unsignedMemberWithdrawTxProgram } from "../src/endpoints/memberWithdraw.js";
import { unsignedExitGroupTxProgram } from "../src/endpoints/exitGroup.js";

import { AccountDatum, GroupDatum } from "../src/core/types.js";
import { LucidContext } from "./context.js";
import { DcuValidators } from "../src/core/validators/context.js";
import {
  selectWalletFromSeed,
  getWalletAddress,
  getUtxosAt,
  signAndSubmit,
  getWalletUtxos
} from "../src/core/index.js";
import { createDefaultAccountDatum, createDefaultGroupDatum } from "./utils.js";

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

// --- Account Actions ---

export const createAccountTestCase = (
  { lucid, users }: LucidContext,
  scripts: DcuValidators,
  datumOverride?: Partial<AccountDatum>,
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
      scripts,
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
  scripts: DcuValidators,
): Effect.Effect<UpdateAccountResult, Error, never> => {
  return Effect.gen(function* () {
    const { lucid } = context;

    const updateAccountTx = yield* unsignedUpdateAccountTxProgram(
      lucid,
      accountUtxo,
      updatedDatum,
      userUtxo,
      scripts,
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
  scripts: DcuValidators,
): Effect.Effect<DeleteAccountResult, Error, never> => {
  return Effect.gen(function* () {
    const { lucid } = context;

    const deleteAccountTx = yield* unsignedDeleteAccountTxProgram(
      lucid,
      accountUtxo,
      userUtxo,
      scripts,
    );
    const txHash = yield* signAndSubmit(deleteAccountTx);
    yield* Effect.promise(() => lucid.awaitTx(txHash));

    return {
      txHash,
    };
  });
};

// --- Group Actions ---

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

// --- Treasury Actions ---

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
