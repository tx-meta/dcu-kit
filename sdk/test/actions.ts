import { Effect, Schedule } from "effect";
import {
  LucidEvolution,
  UTxO,
  fromText,
} from "@lucid-evolution/lucid";
import { unsignedCreateAccountTxProgram, CreateAccountConfig } from "../src/endpoints/createAccount.js";
import { unsignedUpdateAccountTxProgram, UpdateAccountConfig } from "../src/endpoints/updateAccount.js";
import { unsignedDeleteAccountTxProgram, DeleteAccountConfig } from "../src/endpoints/deleteAccount.js";
import { unsignedCreateGroupTxProgram, CreateGroupConfig } from "../src/endpoints/createGroup.js";
import { unsignedUpdateGroupTxProgram, UpdateGroupConfig } from "../src/endpoints/updateGroup.js";
import { unsignedDeleteGroupTxProgram, DeleteGroupConfig } from "../src/endpoints/deleteGroup.js";
import { unsignedJoinGroupTxProgram, JoinGroupConfig } from "../src/endpoints/joinGroup.js";
import { unsignedDistributePayoutTxProgram, DistributePayoutConfig } from "../src/endpoints/distributePayout.js";
import { unsignedMemberWithdrawTxProgram, MemberWithdrawConfig } from "../src/endpoints/memberWithdraw.js";
import { unsignedExitGroupTxProgram, ExitGroupConfig } from "../src/endpoints/exitGroup.js";

import { AccountDatum, GroupDatum } from "../src/core/types.js";
import { LucidContext } from "./context.js";
import { DcuValidators } from "../src/core/validators/context.js";
import { accountValidator, accountPolicyId } from "../src/core/validators/constants.js";
import {
  selectWalletFromSeed,
  getWalletAddress,
  getUtxosAt,
  signAndSubmit,
  getWalletUtxos,
  getScriptAddress
} from "../src/core/index.js";
import { createDefaultAccountDatum, createDefaultGroupDatum } from "./utils.js";
import { SetupError } from "../src/core/errors.js";

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

export type CreateAccountTestParams = {
    datumOverride?: Partial<AccountDatum>;
};

export const createAccountTestCase = (
  context: LucidContext,
  params: CreateAccountTestParams = {},
): Effect.Effect<CreateAccountResult & { outputs: { accountUtxo: UTxO, userUtxo: UTxO } }, Error, never> => {
  return Effect.gen(function* () {
    const { lucid, users } = context;
    const { datumOverride } = params;

    // 1. Arrange
    selectWalletFromSeed(lucid, users.user1.seedPhrase);

    const address = yield* getWalletAddress(lucid);
    const utxos = yield* getUtxosAt(lucid, address);

    const adminTokenHex = "47726f757041646d696e"; 
    const selectedUTxO = utxos.find(u => 
        !Object.keys(u.assets).some(k => k.endsWith(adminTokenHex)) && 
        u.assets.lovelace > 2_000_000n
    ) || utxos[0];

    if (!selectedUTxO) return yield* Effect.fail(new SetupError({ message: "No UTxOs found for user1" }));

    const accountDatum = createDefaultAccountDatum(datumOverride);
    
    // 2. Construct Config
    const accountConfig: CreateAccountConfig = {
        selected_out_ref: selectedUTxO,
        account_datum: accountDatum
    };

    // 3. Act
    const createAccountTx = yield* unsignedCreateAccountTxProgram(
      lucid,
      accountConfig
    );
    const txHash = yield* signAndSubmit(createAccountTx);
    context.emulator?.awaitBlock(1);

    // 4. Verify & Fetch Outputs — retry until indexer has the tx
    const accountScriptAddress = yield* getScriptAddress(lucid, accountValidator.spendAccount);
    const accountUtxo = yield* Effect.tryPromise({
        try: async () => {
            const u = await lucid.utxosAt(accountScriptAddress);
            const found = u.find(x => x.txHash === txHash && Object.keys(x.assets).some(k => k.startsWith(accountPolicyId)));
            if (!found) throw new Error("Account UTxO not indexed yet");
            return found;
        },
        catch: (e) => e
    }).pipe(
        Effect.retry({ schedule: Schedule.spaced(5000).pipe(Schedule.upTo(60000)) }),
        Effect.catchAll(() => Effect.fail(new Error("Account UTxO not found in script after creation")))
    );

    const userUtxo = yield* Effect.tryPromise({
        try: async () => {
            const u = await lucid.wallet().getUtxos();
            const found = u.find(x => x.txHash === txHash && Object.keys(x.assets).some(k => k.startsWith(accountPolicyId)));
            if (!found) throw new Error("User token not indexed yet");
            return found;
        },
        catch: (e) => e
    }).pipe(
        Effect.retry({ schedule: Schedule.spaced(5000).pipe(Schedule.upTo(60000)) }),
        Effect.catchAll(() => Effect.fail(new Error("User Auth Token not found in wallet after creation")))
    );

    return {
      txHash,
      accountConfig: accountDatum,
      outputs: {
          accountUtxo: accountUtxo as UTxO,
          userUtxo: userUtxo as UTxO
      }
    };
  });
};

export type UpdateAccountTestParams = {
    accountUtxo: UTxO;
    userUtxo: UTxO;
    updatedDatum: AccountDatum;
};

export const updateAccountTestCase = (
  context: LucidContext,
  params: UpdateAccountTestParams,
): Effect.Effect<UpdateAccountResult & { outputs: { accountUtxo: UTxO } }, Error, never> => {
  return Effect.gen(function* () {
    const { lucid } = context;
    const { accountUtxo, userUtxo, updatedDatum } = params;

    const updateConfig: UpdateAccountConfig = {
      account_utxo: accountUtxo,
      user_utxo: userUtxo,
      account_datum: updatedDatum
    };

    const updateAccountTx = yield* unsignedUpdateAccountTxProgram(
      lucid,
      updateConfig
    );
    const txHash = yield* signAndSubmit(updateAccountTx);
    context.emulator?.awaitBlock(1);

    const accountScriptAddress = yield* getScriptAddress(lucid, accountValidator.spendAccount);
    const refTokenId = Object.keys(accountUtxo.assets).find(k => k.startsWith(accountPolicyId));
    if (!refTokenId) return yield* Effect.fail(new Error("Could not identify Ref Token in old UTxO"));
    const tokenId = refTokenId;

    const outputUtxo = yield* Effect.tryPromise({
        try: async () => {
            const u = await lucid.utxosAt(accountScriptAddress);
            const found = u.find(x => x.txHash === txHash && Object.keys(x.assets).includes(tokenId));
            if (!found) throw new Error("Updated account UTxO not indexed yet");
            return found as UTxO;
        },
        catch: (e) => e
    }).pipe(
        Effect.retry({ schedule: Schedule.spaced(5000).pipe(Schedule.upTo(60000)) }),
        Effect.catchAll(() => Effect.fail(new Error(`Account UTxO not found after update for token ${refTokenId}`)))
    );

    return {
      txHash,
      outputs: {
          accountUtxo: outputUtxo
      }
    };
  });
};

export type DeleteAccountTestParams = {
    accountUtxo: UTxO;
    userUtxo: UTxO;
};

export const deleteAccountTestCase = (
  context: LucidContext,
  params: DeleteAccountTestParams,
): Effect.Effect<DeleteAccountResult, Error, never> => {
  return Effect.gen(function* () {
    const { lucid } = context;
    const { accountUtxo, userUtxo } = params;
    
    // 1. Construct Config
    const deleteConfig: DeleteAccountConfig = {
        user_utxo: userUtxo,
        account_utxo: accountUtxo
    };

    const deleteAccountTx = yield* unsignedDeleteAccountTxProgram(
      lucid,
      deleteConfig,
    );
    const txHash = yield* signAndSubmit(deleteAccountTx);
    context.emulator?.awaitBlock(1);

    return {
      txHash,
    };
  });
};

// --- Group Actions ---

export type CreateGroupTestParams = {
    datumOverride?: Partial<GroupDatum>;
    creatorSeed?: string; 
};

export const createGroupTestCase = (
    context: LucidContext,
    params: CreateGroupTestParams = {}
): Effect.Effect<CreateGroupResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid, users } = context;
        const { datumOverride, creatorSeed } = params;
        
        // Use provided creator (default ADMIN)
        selectWalletFromSeed(lucid, creatorSeed || users.admin.seedPhrase);

        const utxos = yield* getWalletUtxos(lucid);
        const selectedUTxO = utxos[0];
        if (!selectedUTxO) return yield* Effect.fail(new SetupError({ message: "No UTxOs found for Admin" }));

        const groupDatum = createDefaultGroupDatum(datumOverride);

        const groupConfig: CreateGroupConfig = {
            groupDatum,
            utxoToSpend: selectedUTxO
        };

        const createGroupTx = yield* unsignedCreateGroupTxProgram(lucid, groupConfig);
        const txHash = yield* signAndSubmit(createGroupTx);
        context.emulator?.awaitBlock(1);

        return {
            txHash,
            groupDatum,
        };
    });
};

export type UpdateGroupTestParams = {
    groupUtxo: UTxO;
    updatedDatum: GroupDatum;
    adminUtxo: UTxO;
};

export const updateGroupTestCase = (
    context: LucidContext,
    params: UpdateGroupTestParams
): Effect.Effect<UpdateGroupResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;
        const { groupUtxo, updatedDatum, adminUtxo } = params;

        const updateConfig: UpdateGroupConfig = {
            groupUtxo,
            updatedDatum,
            adminUtxo
        };

        const updateGroupTx = yield* unsignedUpdateGroupTxProgram(
            lucid,
            updateConfig
        );
        const txHash = yield* signAndSubmit(updateGroupTx);
        context.emulator?.awaitBlock(1);

        return {
            txHash,
        };
    });
};

export type DeleteGroupTestParams = {
    groupUtxo: UTxO;
    currentDatum: GroupDatum;
    adminUtxo: UTxO;
};

export const deleteGroupTestCase = (
    context: LucidContext,
    params: DeleteGroupTestParams
): Effect.Effect<DeleteGroupResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;
        const { groupUtxo, currentDatum, adminUtxo } = params;

        const deleteConfig: DeleteGroupConfig = {
            groupUtxo,
            currentDatum,
            adminUtxo
        };

        const deleteGroupTx = yield* unsignedDeleteGroupTxProgram(
            lucid,
            deleteConfig
        );
        const txHash = yield* signAndSubmit(deleteGroupTx);
        context.emulator?.awaitBlock(1);

        return {
            txHash,
        };
    });
};

// --- Treasury Actions ---

export type JoinGroupTestParams = {
    groupUtxo: UTxO;
    accountUtxo: UTxO;
    contributionAmount: bigint;
    userSeed: string; // User joining
};

export const joinGroupTestCase = (
    context: LucidContext,
    params: JoinGroupTestParams
): Effect.Effect<JoinGroupResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;
        const { groupUtxo, accountUtxo, contributionAmount, userSeed } = params;

        selectWalletFromSeed(lucid, userSeed);

        const currentTime = BigInt(
            context.emulator ? context.emulator.now() : Date.now()
        );

        const joinConfig: JoinGroupConfig = {
            groupUtxo,
            accountUtxo,
            contributionAmount,
            currentTime
        };

        const joinTx = yield* unsignedJoinGroupTxProgram(
            lucid,
            joinConfig
        );
        const txHash = yield* signAndSubmit(joinTx);
        context.emulator?.awaitBlock(1);

        return { txHash };
    });
};

export type DistributePayoutTestParams = {
    groupUtxo: UTxO;
    treasuryUtxos: UTxO[];
    callerSeed: string; 
};

export const distributePayoutTestCase = (
    context: LucidContext,
    params: DistributePayoutTestParams
): Effect.Effect<DistributePayoutResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;
        const { groupUtxo, treasuryUtxos, callerSeed } = params;

        selectWalletFromSeed(lucid, callerSeed);

        const payoutConfig: DistributePayoutConfig = {
            groupUtxo,
            treasuryUtxos
        };

        const payoutTx = yield* unsignedDistributePayoutTxProgram(
            lucid,
            payoutConfig
        );
        const txHash = yield* signAndSubmit(payoutTx);
        context.emulator?.awaitBlock(1);

        return { txHash };
    });
};

export type MemberWithdrawTestParams = {
    groupUtxo: UTxO;
    accountUtxo: UTxO;
    treasuryUtxo: UTxO;
    withdrawAmount: bigint;
    userSeed: string;
};

export const memberWithdrawTestCase = (
    context: LucidContext,
    params: MemberWithdrawTestParams
): Effect.Effect<MemberWithdrawResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;
        const { groupUtxo, accountUtxo, treasuryUtxo, withdrawAmount, userSeed } = params;

        selectWalletFromSeed(lucid, userSeed);
        
        const withdrawConfig: MemberWithdrawConfig = {
            groupUtxo,
            accountUtxo,
            treasuryUtxo,
            withdrawAmount
        };

        const withdrawTx = yield* unsignedMemberWithdrawTxProgram(
            lucid,
            withdrawConfig
        );
        const txHash = yield* signAndSubmit(withdrawTx);
        context.emulator?.awaitBlock(1);

        return { txHash };
    });
};

export type ExitGroupTestParams = {
    groupUtxo: UTxO;
    accountUtxo: UTxO;
    treasuryUtxo: UTxO;
    userSeed: string;
};

export const exitGroupTestCase = (
    context: LucidContext,
    params: ExitGroupTestParams
): Effect.Effect<ExitGroupResult, Error, never> => {
    return Effect.gen(function* () {
        const { lucid } = context;
        const { groupUtxo, accountUtxo, treasuryUtxo, userSeed } = params;

        selectWalletFromSeed(lucid, userSeed);
        
        const exitConfig: ExitGroupConfig = {
            groupUtxo,
            accountUtxo,
            treasuryUtxo
        };

        const exitTx = yield* unsignedExitGroupTxProgram(
            lucid,
            exitConfig
        );
        const txHash = yield* signAndSubmit(exitTx);
        context.emulator?.awaitBlock(1);

        return { txHash };
    });
};
