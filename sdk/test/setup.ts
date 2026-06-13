import { Network, UTxO } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  DcuValidators,
  makeValidators,
} from "../src/core/validators/context.js";
import { accountPolicyId } from "../src/core/validators/constants.js";
import {
  createAccountTestCase,
  createGroupTestCase,
  joinGroupTestCase,
} from "./actions.js";
import { GroupDatum } from "../src/core/types.js";
import { LucidContext, makeLucidContext } from "./context.js";
import { SetupError } from "../src/core/errors.js";
import {
  assetNameLabels,
  getScriptAddress,
  selectWalletFromSeed,
} from "../src/core/utils/index.js";
import { advanceBlock, awaitScriptUtxo, awaitWalletUtxo } from "./effects.js";

// --- Types ---

export type BaseSetup = {
  network: Network;
  context: LucidContext;
  scripts: DcuValidators;
};

export type SetupResult = {
  context: LucidContext;
  scripts: DcuValidators;
  accountUtxo?: UTxO;
  userUtxo?: UTxO;
};

export type GroupSetupResult = {
  context: LucidContext;
  scripts: DcuValidators;
  groupDatum: GroupDatum;
  groupUtxo: UTxO;
  adminUtxo: UTxO;
};

export type MembershipSetupResult = {
  context: LucidContext;
  scripts: DcuValidators;
  groupDatum: GroupDatum;
  groupUtxo: UTxO;
  userUtxo: UTxO; // Account (222) token UTxO
  adminUtxo: UTxO;
  memberUtxo: UTxO; // Treasury UTxO
};

// --- Setup Functions ---

export const setupBase = (
  seedAssets?: Record<string, bigint>,
): Effect.Effect<BaseSetup, Error, never> =>
  Effect.gen(function* () {
    const context = yield* makeLucidContext(undefined, seedAssets);
    const { lucid } = context;
    const network = lucid.config().network;
    if (!network)
      return yield* Effect.fail(
        new SetupError({ message: "Invalid Network selection" }),
      );

    // The test suite runs on the Lucid emulator, which deploys the protocol settings
    // and exposes `protocol`. A live NETWORK (e.g. .env's NETWORK=Preprod) skips that
    // deployment, leaving `protocol` undefined. Fail with a clear, actionable message
    // instead of a cryptic "Cannot destructure property 'groupValidator'" downstream.
    if (!context.protocol)
      return yield* Effect.fail(
        new SetupError({
          message:
            `Emulator protocol context missing — the test suite must run on the Lucid ` +
            `emulator. Set NETWORK=Emulator (current NETWORK=${process.env.NETWORK ?? "unset"}). ` +
            `Tip: \`pnpm test\` sets NETWORK=Emulator for you.`,
        }),
      );

    const scripts = yield* makeValidators(network);

    return {
      network,
      context,
      scripts,
    };
  });

export const setupAccount = (
  base: BaseSetup,
): Effect.Effect<SetupResult, Error, never> =>
  Effect.gen(function* () {
    const { emulator } = base.context;
    const { scripts } = base;

    const { outputs } = yield* createAccountTestCase(base.context);
    const { accountUtxo, userUtxo } = outputs;

    // Extra advance so indexers have time to catch up on live networks.
    yield* advanceBlock(emulator, 5);

    return { context: base.context, scripts, accountUtxo, userUtxo };
  });

export const setupGroup = (
  base: BaseSetup,
  datumOverride?: Partial<GroupDatum>,
): Effect.Effect<GroupSetupResult, Error, never> =>
  Effect.gen(function* () {
    const { lucid, users, emulator } = base.context;
    const { scripts } = base;

    const { txHash, groupDatum } = yield* createGroupTestCase(base.context, {
      datumOverride,
      creatorSeed: users.admin.seedPhrase,
    });

    yield* advanceBlock(emulator, 5);

    const groupScriptAddress = yield* getScriptAddress(
      lucid,
      base.context.protocol!.groupValidator.spendGroup,
    );

    const groupUtxo = yield* awaitScriptUtxo(
      lucid,
      groupScriptAddress,
      (x) =>
        x.txHash === txHash &&
        Object.keys(x.assets).some((k) =>
          k.startsWith(base.context.protocol!.groupPolicyId),
        ),
      "Group UTxO not found after creation",
      { maxWaitMs: 120_000 },
    );

    const adminUtxo = yield* awaitWalletUtxo(
      lucid,
      (u) =>
        Object.keys(u.assets).some(
          (k) =>
            k.startsWith(base.context.protocol!.groupPolicyId) &&
            k
              .slice(base.context.protocol!.groupPolicyId.length)
              .startsWith(assetNameLabels.prefix222),
        ),
      "Admin UTxO not found after group creation",
    );

    return { context: base.context, scripts, groupDatum, groupUtxo, adminUtxo };
  });

export const setupMembership = (
  base: BaseSetup,
  groupDatumOverride?: Partial<GroupDatum>,
): Effect.Effect<MembershipSetupResult, Error, never> =>
  Effect.gen(function* () {
    const { context, scripts, groupUtxo, groupDatum } = yield* setupGroup(
      base,
      groupDatumOverride,
    );
    const { lucid, users } = context;

    const { userUtxo } = yield* setupAccount(base);
    if (!userUtxo)
      return yield* Effect.fail(
        new SetupError({ message: "User Account UTxO not found" }),
      );

    // setupAccount switches lucid to user1. Switch back to admin so we can locate
    // the group admin (222) token, which lives in admin's wallet.
    selectWalletFromSeed(lucid, users.admin.seedPhrase);

    const refreshedAdminUtxo = yield* awaitWalletUtxo(
      lucid,
      (u) =>
        Object.keys(u.assets).some(
          (k) =>
            k.startsWith(base.context.protocol!.groupPolicyId) &&
            k
              .slice(base.context.protocol!.groupPolicyId.length)
              .startsWith(assetNameLabels.prefix222),
        ),
      `Admin UTxO not found in admin wallet after Account setup. Policy: ${base.context.protocol!.groupPolicyId}`,
    );

    const { txHash } = yield* joinGroupTestCase(context, {
      groupUtxo,
      accountUtxo: userUtxo,
      userSeed: users.user1.seedPhrase,
    });

    // joinGroupTestCase leaves lucid selecting user1 — the account (222) token is in
    // user1's wallet, so awaitWalletUtxo finds it there.
    const groupScriptAddress = yield* getScriptAddress(
      lucid,
      base.context.protocol!.groupValidator.spendGroup,
    );
    const treasuryScriptAddress = yield* getScriptAddress(
      lucid,
      base.context.protocol!.treasuryValidator.spendTreasury,
    );

    const [accountUtxo2, groupUtxo2, memberUtxo] = yield* Effect.all([
      awaitWalletUtxo(
        lucid,
        (x) =>
          x.txHash === txHash &&
          Object.keys(x.assets).some((k) => k.startsWith(accountPolicyId)),
        "Account UTxO not found after Join",
      ),
      awaitScriptUtxo(
        lucid,
        groupScriptAddress,
        (x) =>
          x.txHash === txHash &&
          Object.keys(x.assets).some((k) =>
            k.startsWith(base.context.protocol!.groupPolicyId),
          ),
        "Group UTxO not found after Join",
      ),
      awaitScriptUtxo(
        lucid,
        treasuryScriptAddress,
        (x) => x.txHash === txHash,
        "Member Treasury UTxO not found after Join",
      ),
    ]);

    return {
      context,
      scripts,
      groupDatum,
      groupUtxo: groupUtxo2,
      userUtxo: accountUtxo2,
      adminUtxo: refreshedAdminUtxo,
      memberUtxo,
    };
  });
