import {
    Network,
    UTxO,
    fromText,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuValidators, makeValidators } from "../src/core/validators/context.js";
import { findUtxoWithToken } from "../src/core/utils.js";
import { 
    createAccountTestCase, 
    createGroupTestCase, 
    joinGroupTestCase 
} from "./actions.js";
import { AccountDatum, GroupDatum } from "../src/core/types.js";
import { LucidContext, makeLucidContext } from "./context.js";
import { SetupError } from "../src/core/errors.js";

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

    // Use TestCase to create the account, passing injected scripts
    yield* createAccountTestCase(
      { lucid, users, emulator },
      scripts,
      datumOverride,
    );

    if (emulator && base.network === "Custom") {
      yield* Effect.sync(() => emulator.awaitBlock(5));
    }

    const accountAddress = scripts.account.spend.address;
    const accountUtxos = yield* Effect.promise(() =>
      lucid.utxosAt(accountAddress),
    );

    const accountPolicyId = scripts.account.mint.policyId;

    const accountReferenceToken =
      accountPolicyId + fromText("AccountReference");
    const accountUtxo = findUtxoWithToken(
      accountUtxos,
      accountPolicyId,
      fromText("AccountReference"),
    );
    if (!accountUtxo) return yield* Effect.die(new SetupError({ message: "Account UTxO not found after creation" }));

    lucid.selectWallet.fromSeed(users.user1.seedPhrase);
    const walletUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());

    const userTokenName = fromText("AccountUser");
    const currentUserUtxo = findUtxoWithToken(
      walletUtxos,
      accountPolicyId,
      userTokenName,
    );
    if (!currentUserUtxo) return yield* Effect.die(new SetupError({ message: "User Auth Token UTxO not found" }));

    return {
      context: base.context,
      scripts,
      accountUtxo,
      userUtxo: currentUserUtxo,
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

     const { groupDatum } = yield* createGroupTestCase(
         base.context,
         scripts,
         datumOverride
     );
     
     if (emulator && base.network === "Custom") {
        yield* Effect.sync(() => emulator.awaitBlock(5));
      }

     const groupPolicyId = scripts.group.mint.policyId!;
     const groupRefTokenName = fromText("GroupReference");
     
     const utxosAtAddress = yield* Effect.promise(() => 
         lucid.utxosAt(scripts.group.spend.address)
     );
     const groupUtxo = findUtxoWithToken(utxosAtAddress, groupPolicyId, groupRefTokenName);
     if (!groupUtxo) return yield* Effect.die(new SetupError({ message: "Group UTxO not found after creation" }));

     const walletUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
     
     // Find the Admin UTxO by token, falling back to the first UTxO if not found.
     const adminTokenName = fromText("GroupAdmin");
     const adminTokenUtxo = findUtxoWithToken(walletUtxos, groupPolicyId, adminTokenName);
     const adminUtxo = adminTokenUtxo || walletUtxos[0]; 

     if (!adminUtxo) return yield* Effect.die(new SetupError({ message: "Admin UTxO not found" }));

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
    contributionAmount: bigint = 100_000_000n, // Default 100 ADA
    groupDatumOverride?: Partial<GroupDatum>
): Effect.Effect<MembershipSetupResult, Error, never> => 
    Effect.gen(function* (_) {
        const { context, scripts, groupUtxo, adminUtxo } = yield* setupGroup(base, groupDatumOverride);
        const { userUtxo } = yield* setupAccount(base);
        const { lucid, users } = context;

        if (!userUtxo) return yield* Effect.die(new SetupError({ message: "User Account UTxO not found" }));

        const groupPolicyId = scripts.group.mint.policyId!;
        const groupRefTokenName = fromText("GroupReference");

        // Refetch Admin UTxO (setupAccount might have spent inputs, invalidating old ref if unlucky, or standard practice)
        const walletUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const adminTokenName = fromText("GroupAdmin");
        const refreshedAdminUtxo = findUtxoWithToken(walletUtxos, groupPolicyId, adminTokenName);
        if (!refreshedAdminUtxo) return yield* Effect.die(new SetupError({ message: "Admin UTxO not found after Account setup" }));

        yield* joinGroupTestCase(
            context,
            groupUtxo,
            userUtxo,
            refreshedAdminUtxo,
            contributionAmount,
            scripts,
            users.user1.seedPhrase
        );

        // --- Refetch All States ---
        
        // 1. Account UTxO
        const accountPolicy = scripts.account.mint.policyId;
        const userUtxos2 = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const accountUtxo2 = userUtxos2.find((u) =>
           Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
        );
        if (!accountUtxo2) return yield* Effect.die(new SetupError({ message: "Account UTxO not found after Join" }));

         // 2. Group UTxO
         const groupScriptAddr = scripts.group.spend.address;
         const groupUtxos2 = yield* Effect.promise(() =>
          lucid.utxosAt(groupScriptAddr),
        );
         const groupUtxo2 = groupUtxos2.find((u) =>
          Object.keys(u.assets).some((k) => k.includes(groupRefTokenName)),
        );
         if (!groupUtxo2) return yield* Effect.die(new SetupError({ message: "Group UTxO not found after Join" }));

         // 3. Treasury UTxO (Member)
        const treasuryUtxos = yield* Effect.promise(() =>
            lucid.utxosAt(scripts.treasury.spend.address),
        );
        // Assuming first one is ours for this simple test flow
        const memberUtxo = treasuryUtxos[0];
        if (!memberUtxo) return yield* Effect.die(new SetupError({ message: "Member Treasury UTxO not found after Join" }));

        return {
            context,
            scripts,
            groupUtxo: groupUtxo2,
            userUtxo: accountUtxo2,
            adminUtxo: refreshedAdminUtxo,
            memberUtxo
        };
    });
