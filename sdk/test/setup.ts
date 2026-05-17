import {
    Network,
    UTxO,
} from "@lucid-evolution/lucid";
import { Effect, Schedule } from "effect";
import { DcuValidators, makeValidators } from "../src/core/validators/context.js";
import {
    groupPolicyId,
    groupValidator,
    treasuryValidator,
    accountPolicyId,
} from "../src/core/validators/constants.js";
import {
    createAccountTestCase,
    createGroupTestCase,
    joinGroupTestCase
} from "./actions.js";
import { GroupDatum } from "../src/core/types.js";
import { LucidContext, makeLucidContext } from "./context.js";
import { SetupError } from "../src/core/errors.js";
import { assetNameLabels, getScriptAddress } from "../src/core/utils/index.js";

// --- Test Helper Setup ---

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

export const setupBase = (): Effect.Effect<BaseSetup, Error, never> => {
  return Effect.gen(function* (_) {
    const { lucid, users, emulator } = yield* makeLucidContext();
    const network = lucid.config().network;
    if (!network) return yield* Effect.fail(new SetupError({ message: "Invalid Network selection" }));

    const scripts = yield* makeValidators(network);

    return {
      network,
      context: { lucid, users, emulator },
      scripts,
    };
  });
};

export const setupAccount = (
  base: BaseSetup,
): Effect.Effect<SetupResult, Error, never> =>
  Effect.gen(function* (_) {
    const { lucid, users, emulator } = base.context;
    const { scripts } = base;

    const { outputs } = yield* createAccountTestCase(
      { lucid, users, emulator },
    );

    const { accountUtxo, userUtxo } = outputs;

    if (emulator && base.network === "Custom") {
      yield* Effect.sync(() => emulator.awaitBlock(5));
    }

    return {
      context: base.context,
      scripts,
      accountUtxo,
      userUtxo,
    };
  });

export type GroupSetupResult = {
  context: LucidContext;
  scripts: DcuValidators;
  groupDatum: GroupDatum; 
  groupUtxo: UTxO;
  adminUtxo: UTxO;
};

export const setupGroup = (
  base: BaseSetup,
  datumOverride?: Partial<GroupDatum>
): Effect.Effect<GroupSetupResult, Error, never> =>
  Effect.gen(function* (_) {
     const { lucid, users, emulator } = base.context;
     const { scripts } = base;

     const { txHash, groupDatum } = yield* createGroupTestCase(
         base.context,
         {
             datumOverride,
             creatorSeed: users.user1.seedPhrase
         }
     );

     if (emulator && base.network === "Custom") {
        yield* Effect.sync(() => emulator.awaitBlock(5));
     }

     const groupScriptAddress = yield* getScriptAddress(lucid, groupValidator.spendGroup);

     const groupUtxo = yield* Effect.tryPromise({
         try: async () => {
             const timeout = new Promise<never>((_, reject) =>
                 setTimeout(() => reject(new Error("utxosAt timeout")), 20_000)
             );
             const u = await Promise.race([lucid.utxosAt(groupScriptAddress), timeout]);
             const found = u.find(
                 (x) => x.txHash === txHash &&
                 Object.keys(x.assets).some(k => k.startsWith(groupPolicyId!))
             );
             if (!found) throw new Error("Group UTxO not indexed yet");
             return found;
         },
         catch: (e) => e,
     }).pipe(
         Effect.retry({ schedule: Schedule.spaced(5000).pipe(Schedule.upTo(120_000)) }),
         Effect.catchAll((e) => Effect.fail(new SetupError({ message: `Group UTxO not found after creation: ${e}` })))
     );

     const walletUtxos = yield* Effect.tryPromise({
         try: () => lucid.wallet().getUtxos(),
         catch: (e) => new SetupError({ message: `Failed to get wallet UTxOs: ${e}` })
     });

     const adminUtxo = walletUtxos.find(u =>
         Object.keys(u.assets).some(k =>
             k.startsWith(groupPolicyId!) &&
             k.slice(groupPolicyId!.length).startsWith(assetNameLabels.prefix222)
         )
     );
     if (!adminUtxo) return yield* Effect.fail(new SetupError({ message: "Admin UTxO not found" }));

     return {
         context: base.context,
         scripts,
         groupDatum,
         groupUtxo,
         adminUtxo,
     };
  });

export type MembershipSetupResult = {
    context: LucidContext;
    scripts: DcuValidators;
    groupUtxo: UTxO;
    userUtxo: UTxO; // Account UTxO
    adminUtxo: UTxO;
    memberUtxo: UTxO; // Treasury UTxO
};

export const setupMembership = (
    base: BaseSetup,
    contributionAmount: bigint = 50_000_000n, // Default 50 ADA
    groupDatumOverride?: Partial<GroupDatum>
): Effect.Effect<MembershipSetupResult, Error, never> => 
    Effect.gen(function* (_) {
        const { context, scripts, groupUtxo } = yield* setupGroup(base, groupDatumOverride);
        const { userUtxo } = yield* setupAccount(base);
        const { lucid, users } = context;

        if (!userUtxo) return yield* Effect.fail(new SetupError({ message: "User Account UTxO not found" }));

        const walletUtxos = yield* Effect.tryPromise({
            try: () => lucid.wallet().getUtxos(),
            catch: (e) => new SetupError({ message: `Failed to get wallet UTxOs: ${e}` })
        });

        const refreshedAdminUtxo = walletUtxos.find(u =>
            Object.keys(u.assets).some(k =>
                k.startsWith(groupPolicyId!) &&
                k.slice(groupPolicyId!.length).startsWith(assetNameLabels.prefix222)
            )
        );
        if (!refreshedAdminUtxo) return yield* Effect.fail(new SetupError({
            message: `Admin UTxO not found after Account setup. Policy: ${groupPolicyId}`
        }));

        const { txHash } = yield* joinGroupTestCase(
            context,
            {
                groupUtxo,
                accountUtxo: userUtxo, // Maps from SetupResult userUtxo (Account)
                contributionAmount,
                userSeed: users.user1.seedPhrase
            }
        );

        // --- Refetch All States (With Retries for Indexers) ---
        
        const groupScriptAddress = yield* getScriptAddress(lucid, groupValidator.spendGroup);
        const treasuryScriptAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);

        // 1. Account UTxO
        const accountUtxo2 = yield* Effect.tryPromise({
            try: async () => {
                const u = await lucid.wallet().getUtxos();
                const found = u.find((x) => x.txHash === txHash && Object.keys(x.assets).some((k) => k.startsWith(accountPolicyId)));
                if (!found) throw new Error("Account not indexed");
                return found;
            },
            catch: (e) => e
        }).pipe(
            Effect.retry({ schedule: Schedule.spaced(5000).pipe(Schedule.upTo(60000)) }),
            Effect.catchAll(() => Effect.fail(new SetupError({ message: "Account UTxO not found after Join" })))
        );

        // 2. Group UTxO
        const groupUtxo2 = yield* Effect.tryPromise({
            try: async () => {
                const u = await lucid.utxosAt(groupScriptAddress);
                const found = u.find((x) => x.txHash === txHash && Object.keys(x.assets).some((k) => k.startsWith(groupPolicyId!)));
                if (!found) throw new Error("Group not indexed");
                return found;
            },
            catch: (e) => e
        }).pipe(
            Effect.retry({ schedule: Schedule.spaced(5000).pipe(Schedule.upTo(60000)) }),
            Effect.catchAll(() => Effect.fail(new SetupError({ message: "Group UTxO not found after Join" })))
        );

        // 3. Treasury UTxO (Member)
        const memberUtxo = yield* Effect.tryPromise({
            try: async () => {
                const u = await lucid.utxosAt(treasuryScriptAddress);
                const found = u.find((x) => x.txHash === txHash);
                if (!found) throw new Error("Treasury not indexed");
                return found;
            },
            catch: (e) => e
        }).pipe(
            Effect.retry({ schedule: Schedule.spaced(5000).pipe(Schedule.upTo(60000)) }),
            Effect.catchAll(() => Effect.fail(new SetupError({ message: "Member Treasury UTxO not found after Join" })))
        );


        return {
            context,
            scripts,
            groupUtxo: groupUtxo2,
            userUtxo: accountUtxo2,
            adminUtxo: refreshedAdminUtxo,
            memberUtxo
        };
    });
