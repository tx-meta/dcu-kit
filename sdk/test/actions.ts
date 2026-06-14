import { Effect } from "effect";
import { UTxO } from "@lucid-evolution/lucid";
import {
  unsignedCreateAccountTxProgram,
  CreateAccountConfig,
} from "../src/endpoints/createAccount.js";
import {
  unsignedUpdateAccountTxProgram,
  UpdateAccountConfig,
} from "../src/endpoints/updateAccount.js";
import {
  unsignedDeleteAccountTxProgram,
  DeleteAccountConfig,
} from "../src/endpoints/deleteAccount.js";
import {
  unsignedCreateGroupTxProgram,
  CreateGroupConfig,
} from "../src/endpoints/createGroup.js";
import {
  unsignedUpdateGroupTxProgram,
  UpdateGroupConfig,
} from "../src/endpoints/updateGroup.js";
import {
  unsignedDeleteGroupTxProgram,
  DeleteGroupConfig,
} from "../src/endpoints/deleteGroup.js";
import {
  unsignedJoinGroupTxProgram,
  JoinGroupConfig,
} from "../src/endpoints/joinGroup.js";
import {
  unsignedDistributePayoutTxProgram,
  DistributePayoutConfig,
} from "../src/endpoints/distributePayout.js";
import {
  unsignedStartGroupTxProgram,
  StartGroupConfig,
} from "../src/endpoints/startGroup.js";
import {
  unsignedExitGroupTxProgram,
  ExitGroupConfig,
} from "../src/endpoints/exitGroup.js";
import { GroupDatum } from "../src/core/types.js";
import { LucidContext } from "./context.js";
import {
  accountPolicyId,
  accountValidator,
} from "../src/core/validators/constants.js";
import {
  assetNameLabels,
  getScriptAddress,
  getUtxosAt,
  getWalletAddress,
  getWalletUtxos,
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/index.js";
import { createDefaultGroupDatum, extractTokenSuffix } from "./utils.js";
import { SetupError } from "../src/core/errors.js";
import {
  advanceBlock,
  awaitScriptUtxo,
  awaitWalletUtxo,
  fetchScriptUtxosByTxHash,
} from "./effects.js";

// --- Result Types ---

export type CreateAccountResult = { txHash: string };
export type UpdateAccountResult = { txHash: string };
export type DeleteAccountResult = { txHash: string };
export type CreateGroupResult = { txHash: string; groupDatum: GroupDatum };
export type UpdateGroupResult = { txHash: string };
export type DeleteGroupResult = { txHash: string };
export type JoinGroupResult = { txHash: string };
export type ExitGroupResult = { txHash: string };

export type DistributePayoutResult = {
  txHash: string;
  // Updated treasury UTxOs produced by the tx (one per member, claimable entries removed)
  treasuryOutputs: UTxO[];
};

// --- Account Actions ---

export type CreateAccountTestParams = {
  display_name?: string;
  contact?: string;
  userSeed?: string; // defaults to users.user1 if not provided
};

export const createAccountTestCase = (
  context: LucidContext,
  params: CreateAccountTestParams = {},
): Effect.Effect<
  CreateAccountResult & {
    outputs: { accountUtxo: UTxO; userUtxo: UTxO };
    accountTokenSuffix: string;
  },
  Error,
  never
> =>
  Effect.gen(function* () {
    const { lucid, users } = context;
    const { display_name, contact, userSeed } = params;

    selectWalletFromSeed(lucid, userSeed ?? users.user1.seedPhrase);

    const address = yield* getWalletAddress(lucid);
    const utxos = yield* getUtxosAt(lucid, address);

    // Exclude UTxOs that already carry the group admin (222) token — they were produced
    // by a prior createGroup tx and would fail the CIP-68 uniqueness check if reused
    // as the mint input for createAccount.
    // "47726f757041646d696e" == fromText("GroupAdmin") — the fixed asset name used by
    // the group validator's CreateGroup minting path.
    const adminTokenHex = "47726f757041646d696e";
    const selectedUTxO = utxos.find(
      (u) =>
        !Object.keys(u.assets).some((k) => k.endsWith(adminTokenHex)) &&
        u.assets.lovelace > 2_000_000n,
    );
    if (!selectedUTxO)
      return yield* Effect.fail(
        new SetupError({
          message: "No UTxO with sufficient lovelace found for user1",
        }),
      );

    const accountConfig: CreateAccountConfig = {
      selected_out_ref: selectedUTxO,
      display_name,
      contact,
    };

    const { tx: createAccountTx, accountTokenSuffix } =
      yield* unsignedCreateAccountTxProgram(lucid, accountConfig).pipe(
        Effect.timeout("60 seconds"),
        Effect.catchTag("TimeoutException", () =>
          Effect.fail(
            new SetupError({
              message: "createAccount completeProgram timed out",
            }),
          ),
        ),
      );
    const txHash = yield* signAndSubmit(createAccountTx);
    yield* advanceBlock(context.emulator);

    const accountScriptAddress = yield* getScriptAddress(
      lucid,
      accountValidator.spendAccount,
    );

    const [accountUtxo, userUtxo] = yield* Effect.all([
      awaitScriptUtxo(
        lucid,
        accountScriptAddress,
        (x) =>
          x.txHash === txHash &&
          Object.keys(x.assets).some((k) => k.startsWith(accountPolicyId)),
        "Account UTxO not found in script after creation",
      ),
      awaitWalletUtxo(
        lucid,
        (x) =>
          x.txHash === txHash &&
          Object.keys(x.assets).some((k) => k.startsWith(accountPolicyId)),
        "User Auth Token not found in wallet after creation",
      ),
    ]);

    return {
      txHash,
      outputs: { accountUtxo, userUtxo },
      accountTokenSuffix,
    };
  });

export type UpdateAccountTestParams = {
  accountUtxo: UTxO;
  display_name?: string;
  contact?: string;
};

export const updateAccountTestCase = (
  context: LucidContext,
  params: UpdateAccountTestParams,
): Effect.Effect<
  UpdateAccountResult & { outputs: { accountUtxo: UTxO } },
  Error,
  never
> =>
  Effect.gen(function* () {
    const { lucid } = context;
    const { accountUtxo, display_name, contact } = params;

    const accountTokenSuffix = extractTokenSuffix(
      accountUtxo,
      accountPolicyId,
      assetNameLabels.prefix100,
    );
    const updateConfig: UpdateAccountConfig = {
      accountTokenSuffix,
      display_name,
      contact,
    };

    const updateAccountTx = yield* unsignedUpdateAccountTxProgram(
      lucid,
      updateConfig,
    );
    const txHash = yield* signAndSubmit(updateAccountTx);
    yield* advanceBlock(context.emulator);

    const accountScriptAddress = yield* getScriptAddress(
      lucid,
      accountValidator.spendAccount,
    );
    const refTokenId = Object.keys(accountUtxo.assets).find((k) =>
      k.startsWith(accountPolicyId),
    );
    if (!refTokenId)
      return yield* Effect.fail(
        new Error("Could not identify Ref Token in old UTxO"),
      );

    const outputUtxo = yield* awaitScriptUtxo(
      lucid,
      accountScriptAddress,
      (x) => x.txHash === txHash && Object.keys(x.assets).includes(refTokenId),
      `Account UTxO not found after update for token ${refTokenId}`,
    );

    return { txHash, outputs: { accountUtxo: outputUtxo } };
  });

export type DeleteAccountTestParams = { accountUtxo: UTxO };

export const deleteAccountTestCase = (
  context: LucidContext,
  params: DeleteAccountTestParams,
): Effect.Effect<DeleteAccountResult, Error, never> =>
  Effect.gen(function* () {
    const { lucid } = context;
    const { accountUtxo } = params;

    const accountTokenSuffix = extractTokenSuffix(
      accountUtxo,
      accountPolicyId,
      assetNameLabels.prefix100,
    );
    const deleteConfig: DeleteAccountConfig = { accountTokenSuffix };

    const deleteAccountTx = yield* unsignedDeleteAccountTxProgram(
      context.protocol!,
      lucid,
      deleteConfig,
    );
    const txHash = yield* signAndSubmit(deleteAccountTx);
    yield* advanceBlock(context.emulator);

    return { txHash };
  });

// --- Group Actions ---

export type CreateGroupTestParams = {
  datumOverride?: Partial<GroupDatum>;
  creatorSeed?: string;
  groupName?: string;
  groupDescription?: string;
};

export const createGroupTestCase = (
  context: LucidContext,
  params: CreateGroupTestParams = {},
): Effect.Effect<
  CreateGroupResult & { groupTokenSuffix: string },
  Error,
  never
> =>
  Effect.gen(function* () {
    const { lucid, users } = context;
    const { datumOverride, creatorSeed, groupName, groupDescription } = params;

    selectWalletFromSeed(lucid, creatorSeed ?? users.admin.seedPhrase);

    const utxos = yield* getWalletUtxos(lucid);
    const selectedUTxO = utxos[0];
    if (!selectedUTxO)
      return yield* Effect.fail(
        new SetupError({ message: "No UTxOs found for Admin" }),
      );

    const groupDatum = createDefaultGroupDatum(datumOverride);
    const groupConfig: CreateGroupConfig = {
      groupName: groupName ?? "Test Group",
      ...(groupDescription !== undefined ? { groupDescription } : {}),
      groupDatum,
      utxoToSpend: selectedUTxO,
    };

    const { tx: createGroupTx, groupTokenSuffix } =
      yield* unsignedCreateGroupTxProgram(
        context.protocol!,
        lucid,
        groupConfig,
      );
    const txHash = yield* signAndSubmit(createGroupTx);
    yield* advanceBlock(context.emulator);

    return { txHash, groupDatum, groupTokenSuffix };
  });

export type UpdateGroupTestParams = {
  groupUtxo: UTxO;
  updatedDatum: GroupDatum;
};

export const updateGroupTestCase = (
  context: LucidContext,
  params: UpdateGroupTestParams,
): Effect.Effect<UpdateGroupResult, Error, never> =>
  Effect.gen(function* () {
    const { lucid } = context;
    const { groupUtxo, updatedDatum } = params;

    const groupTokenSuffix = extractTokenSuffix(
      groupUtxo,
      context.protocol!.groupPolicyId,
      assetNameLabels.prefix100,
    );
    const updateConfig: UpdateGroupConfig = { groupTokenSuffix, updatedDatum };

    const updateGroupTx = yield* unsignedUpdateGroupTxProgram(
      context.protocol!,
      lucid,
      updateConfig,
    );
    const txHash = yield* signAndSubmit(updateGroupTx);
    yield* advanceBlock(context.emulator);

    return { txHash };
  });

export type DeleteGroupTestParams = { groupUtxo: UTxO };

export const deleteGroupTestCase = (
  context: LucidContext,
  params: DeleteGroupTestParams,
): Effect.Effect<DeleteGroupResult, Error, never> =>
  Effect.gen(function* () {
    const { lucid } = context;
    const { groupUtxo } = params;

    const groupTokenSuffix = extractTokenSuffix(
      groupUtxo,
      context.protocol!.groupPolicyId,
      assetNameLabels.prefix100,
    );
    const deleteConfig: DeleteGroupConfig = { groupTokenSuffix };

    const deleteGroupTx = yield* unsignedDeleteGroupTxProgram(
      context.protocol!,
      lucid,
      deleteConfig,
    );
    const txHash = yield* signAndSubmit(deleteGroupTx);
    yield* advanceBlock(context.emulator);

    return { txHash };
  });

// --- Treasury Actions ---

export type JoinGroupTestParams = {
  groupUtxo: UTxO;
  accountUtxo: UTxO;
  userSeed: string;
};

export const joinGroupTestCase = (
  context: LucidContext,
  params: JoinGroupTestParams,
): Effect.Effect<JoinGroupResult, Error, never> =>
  Effect.gen(function* () {
    const { lucid } = context;
    const { groupUtxo, accountUtxo, userSeed } = params;

    selectWalletFromSeed(lucid, userSeed);

    const currentTime = BigInt(
      context.emulator ? context.emulator.now() : Date.now(),
    );

    const groupTokenSuffix = extractTokenSuffix(
      groupUtxo,
      context.protocol!.groupPolicyId,
      assetNameLabels.prefix100,
    );
    const accountTokenSuffix = extractTokenSuffix(
      accountUtxo,
      accountPolicyId,
      assetNameLabels.prefix222,
    );

    const joinConfig: JoinGroupConfig = {
      groupTokenSuffix,
      accountTokenSuffix,
      currentTime,
    };

    const joinTx = yield* unsignedJoinGroupTxProgram(
      context.protocol!,
      lucid,
      joinConfig,
    );
    const txHash = yield* signAndSubmit(joinTx);
    yield* advanceBlock(context.emulator);

    return { txHash };
  });

export type StartGroupTestParams = {
  groupUtxo: UTxO;
  adminSeed?: string;
  currentTime?: bigint;
};

export const startGroupTestCase = (
  context: LucidContext,
  params: StartGroupTestParams,
): Effect.Effect<{ txHash: string }, Error, never> =>
  Effect.gen(function* () {
    const { lucid, users } = context;
    const { groupUtxo, adminSeed, currentTime } = params;

    selectWalletFromSeed(lucid, adminSeed ?? users.admin.seedPhrase);

    const currentTimeFinal =
      currentTime ??
      BigInt(context.emulator ? context.emulator.now() : Date.now());
    const groupTokenSuffix = extractTokenSuffix(
      groupUtxo,
      context.protocol!.groupPolicyId,
      assetNameLabels.prefix100,
    );
    const startConfig: StartGroupConfig = {
      groupTokenSuffix,
      currentTime: currentTimeFinal,
    };

    const startTx = yield* unsignedStartGroupTxProgram(
      context.protocol!,
      lucid,
      startConfig,
    );
    const txHash = yield* signAndSubmit(startTx);
    yield* advanceBlock(context.emulator);

    return { txHash };
  });

export type DistributePayoutTestParams = {
  groupUtxo: UTxO;
  callerSeed: string;
};

export const distributePayoutTestCase = (
  context: LucidContext,
  params: DistributePayoutTestParams,
): Effect.Effect<DistributePayoutResult, Error, never> =>
  Effect.gen(function* () {
    const { lucid } = context;
    const { groupUtxo, callerSeed } = params;

    selectWalletFromSeed(lucid, callerSeed);

    const groupTokenSuffix = extractTokenSuffix(
      groupUtxo,
      context.protocol!.groupPolicyId,
      assetNameLabels.prefix100,
    );
    const payoutConfig: DistributePayoutConfig = { groupTokenSuffix };

    const payoutTx = yield* unsignedDistributePayoutTxProgram(
      context.protocol!,
      lucid,
      payoutConfig,
    );
    const txHash = yield* signAndSubmit(payoutTx);
    yield* advanceBlock(context.emulator);

    const treasuryAddress = yield* getScriptAddress(
      lucid,
      context.protocol!.treasuryValidator.spendTreasury,
    );
    const treasuryOutputs = yield* fetchScriptUtxosByTxHash(
      lucid,
      treasuryAddress,
      txHash,
      "Failed to fetch treasury outputs after payout",
    );

    return { txHash, treasuryOutputs };
  });

export type ExitGroupTestParams = {
  groupUtxo: UTxO;
  accountUtxo: UTxO;
  userSeed: string;
};

export const exitGroupTestCase = (
  context: LucidContext,
  params: ExitGroupTestParams,
): Effect.Effect<ExitGroupResult, Error, never> =>
  Effect.gen(function* () {
    const { lucid } = context;
    const { groupUtxo, accountUtxo, userSeed } = params;

    selectWalletFromSeed(lucid, userSeed);

    const currentTime = BigInt(
      context.emulator ? context.emulator.now() : Date.now(),
    );
    const groupTokenSuffix = extractTokenSuffix(
      groupUtxo,
      context.protocol!.groupPolicyId,
      assetNameLabels.prefix100,
    );
    const accountTokenSuffix = extractTokenSuffix(
      accountUtxo,
      accountPolicyId,
      assetNameLabels.prefix222,
    );

    const exitConfig: ExitGroupConfig = {
      groupTokenSuffix,
      accountTokenSuffix,
      currentTime,
    };

    const exitTx = yield* unsignedExitGroupTxProgram(
      context.protocol!,
      lucid,
      exitConfig,
    );
    const txHash = yield* signAndSubmit(exitTx);
    yield* advanceBlock(context.emulator);

    return { txHash };
  });

