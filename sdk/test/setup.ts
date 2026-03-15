import {
    Network,
    UTxO,
    fromText,
} from "@lucid-evolution/lucid";
import { Effect, Schedule } from "effect";
import { DcuValidators, makeValidators } from "../src/core/validators/context.js";
import { findUtxoWithToken } from "../src/core/utils/index.js";
import { 
    createAccountTestCase, 
    createGroupTestCase, 
    joinGroupTestCase 
} from "./actions.js";
import { AccountDatum, GroupDatum } from "../src/core/types.js";
import { LucidContext, makeLucidContext } from "./context.js";
import { SetupError } from "../src/core/errors.js";
import { assetNameLabels, findCip68TokenPair, waitForTx } from "../src/core/utils/index.js";

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
    if (!network) return yield* Effect.die(new SetupError({ message: "Invalid Network selection" }));

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
  datumOverride?: Partial<AccountDatum>,
): Effect.Effect<SetupResult, Error, never> =>
  Effect.gen(function* (_) {
    const { lucid, users, emulator } = base.context;
    const { scripts } = base;

    const { txHash, outputs } = yield* createAccountTestCase(
      { lucid, users, emulator },
      { datumOverride },
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

     const groupPolicyId = scripts.group.mint.policyId!;
     const groupRefTokenName = fromText("GroupReference");
     
     const utxosAtAddress = yield* Effect.promise(() => 
         lucid.utxosAt(scripts.group.spend.address)
     );
     
     // Filter by txHash to ensure we get the specific UTxO created in this test run
     const groupUtxo = utxosAtAddress.find(
       (u) => 
         u.txHash === txHash && 
         Object.keys(u.assets).includes(groupPolicyId + groupRefTokenName)
     );

     if (!groupUtxo) return yield* Effect.die(new SetupError({ message: "Group UTxO not found after creation" }));

     const walletUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());

     // Find the Admin UTxO by token, falling back to the first UTxO if not found.
     const adminTokenName = fromText("GroupAdmin");
    const adminUtxo = yield* findUtxoWithToken(walletUtxos, scripts.group.mint.policyId!, adminTokenName).pipe(
        Effect.catchAll(() => Effect.die(new SetupError({ message: "Admin UTxO not found" })))
    );


     return {
         context: base.context,
         scripts,
         groupDatum,
         groupUtxo,
         adminUtxo: adminUtxo
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
        const { context, scripts, groupUtxo, adminUtxo } = yield* setupGroup(base, groupDatumOverride);
        const { userUtxo } = yield* setupAccount(base);
        const { lucid, users } = context;

        if (!userUtxo) return yield* Effect.die(new SetupError({ message: "User Account UTxO not found" }));

        const groupPolicyId = scripts.group.mint.policyId!;
        const groupRefTokenName = fromText("GroupReference");

        // Refetch Admin UTxO (User1 is now Admin, so it should be in walletUtxos)
        const walletUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
        
        const adminTokenName = fromText("GroupAdmin");
        const refreshedAdminUtxo = yield* findUtxoWithToken(walletUtxos, groupPolicyId, adminTokenName).pipe(
             Effect.catchAll(() => Effect.die(new SetupError({ 
                 message: `Admin UTxO not found after Account setup. Policy: ${groupPolicyId}` 
             })))
        );

        const { txHash } = yield* joinGroupTestCase(
            context,
            {
                groupUtxo,
                accountUtxo: userUtxo, // Maps from SetupResult userUtxo (Account)
                adminUtxo,
                contributionAmount,
                userSeed: users.user1.seedPhrase
            }
        );

        // --- Wait for Confirmation ---
        if (context.emulator && base.network === "Custom") {
            yield* Effect.sync(() => context.emulator!.awaitBlock(1));
        } else {
            // Poll for confirmation on live network (Maestro/Preprod)
            yield* waitForTx(lucid, txHash);
        }

        // --- Refetch All States (With Retries for Indexers) ---
        
        // 1. Account UTxO
        const accountPolicy = scripts.account.mint.policyId;
        const accountUtxo2 = yield* Effect.tryPromise({
            try: async () => {
                const u = await lucid.wallet().getUtxos();
                const found = u.find((x) => x.txHash === txHash && Object.keys(x.assets).some((k) => k.startsWith(accountPolicy)));
                if (!found) throw new Error("Account not indexed");
                return found;
            },
            catch: (e) => e
        }).pipe(
            Effect.retry({ schedule: Schedule.spaced(5000).pipe(Schedule.upTo(60000)) }),
            Effect.catchAll(() => Effect.die(new SetupError({ message: "Account UTxO not found after Join" })))
        );

         // 2. Group UTxO
         const groupScriptAddr = scripts.group.spend.address;
         const groupUtxo2 = yield* Effect.tryPromise({
             try: async () => {
                 const u = await lucid.utxosAt(groupScriptAddr);
                 const found = u.find((x) => x.txHash === txHash && Object.keys(x.assets).some((k) => k.includes(groupRefTokenName)));
                 if (!found) throw new Error("Group not indexed");
                 return found;
             },
             catch: (e) => e
         }).pipe(
             Effect.retry({ schedule: Schedule.spaced(5000).pipe(Schedule.upTo(60000)) }),
             Effect.catchAll(() => Effect.die(new SetupError({ message: "Group UTxO not found after Join" })))
         );

         // 3. Treasury UTxO (Member)
        const memberUtxo = yield* Effect.tryPromise({
            try: async () => {
                const u = await lucid.utxosAt(scripts.treasury.spend.address);
                const found = u.find((x) => x.txHash === txHash);
                if (!found) throw new Error("Treasury not indexed");
                return found;
            },
            catch: (e) => e
        }).pipe(
            Effect.retry({ schedule: Schedule.spaced(5000).pipe(Schedule.upTo(60000)) }),
            Effect.catchAll(() => Effect.die(new SetupError({ message: "Member Treasury UTxO not found after Join" })))
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
