import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  joinGroupTestCase,
  exitGroupTestCase,
  memberWithdrawTestCase,
  distributePayoutTestCase,
  createAccountTestCase,
  createGroupTestCase
} from "./actions.js";
import { setupBase } from "./helpers/setupTest.js";
import { fromText } from "@lucid-evolution/lucid";
import { unsignedTerminateGroupTxProgram } from "../src/endpoints/terminateGroup.js";
import { signAndSubmit } from "../src/core/utils.js";

describe("Treasury Endpoints", () => {
  // --- Join Group ---
  it.effect("should allow a user with an account to join a group", () =>
    Effect.gen(function* () {
      const { context, scripts } = yield* setupBase();
      const { lucid, users } = context;

      // 1. Create Group first to avoid consuming Account UTxO
      yield* createGroupTestCase(context, scripts);

      // 2. Create Account
      yield* createAccountTestCase(context, scripts);

      // 3. Find Group Reference UTxO
      const groupScriptAddr = scripts.group.spend.address;
      const groupUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupName = fromText("GroupReference");
      const foundGroupUtxo = groupUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );
      if (!foundGroupUtxo) throw new Error("Group UTxO not found");

      // 4. Find Account UTxO
      lucid.selectWallet.fromSeed(users.user1.seedPhrase);
      const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountPolicy = scripts.account.mint.policyId;
      const accountUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
      );
      if (!accountUtxo) throw new Error("Account UTxO not found");

      const adminTokenName = fromText("GroupAdmin");
      const adminUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.endsWith(adminTokenName)),
      );
      if (!adminUtxo) throw new Error("Admin UTxO not found");

      const result = yield* joinGroupTestCase(
        context,
        foundGroupUtxo!,
        accountUtxo!,
        adminUtxo,
        100_000_000n,
        scripts,
        users.user1.seedPhrase,
      );
      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Exit Group (Standard) ---
  it.effect("should allow a member to exit", () =>
    Effect.gen(function* () {
      const { context, scripts } = yield* setupBase();
      const { lucid, users } = context;

      yield* createGroupTestCase(context, scripts);
      yield* createAccountTestCase(context, scripts);

      const groupScriptAddr = scripts.group.spend.address;
      const groupUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupName = fromText("GroupReference");
      const foundGroupUtxo = groupUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );

      lucid.selectWallet.fromSeed(users.user1.seedPhrase);
      const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountPolicy = scripts.account.mint.policyId;
      const accountUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
      );
      const adminTokenName = fromText("GroupAdmin");
      const adminUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.endsWith(adminTokenName)),
      );

      yield* joinGroupTestCase(
        context,
        foundGroupUtxo!,
        accountUtxo!,
        adminUtxo!,
        100_000_000n,
        scripts,
        users.user1.seedPhrase,
      );

      // Fetch for Exit
      const userUtxos2 = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountUtxo2 = userUtxos2.find((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
      );
      const groupUtxos2 = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupUtxo2 = groupUtxos2.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );
      const treasuryUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(scripts.treasury.spend.address),
      );
      const memberUtxo = treasuryUtxos[0];

      const result = yield* exitGroupTestCase(
        context,
        groupUtxo2!,
        accountUtxo2!,
        memberUtxo!,
        scripts,
        users.user1.seedPhrase,
      );

      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Exit Group (Mature) ---
  it.effect("should allow a member to exit gracefully (mature)", () =>
    Effect.gen(function* () {
      const { context, scripts } = yield* setupBase();
      const { lucid, users } = context;

      // Old start time to force maturity
      const oneHour = 3600000n;
      const now = BigInt(Date.now());
      const oldStartTime = now - 11n * oneHour;

      yield* createGroupTestCase(context, scripts, {
        start_time: oldStartTime,
      });
      yield* createAccountTestCase(context, scripts);

      const groupScriptAddr = scripts.group.spend.address;
      const groupUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupName = fromText("GroupReference");
      const foundGroupUtxo = groupUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );

      lucid.selectWallet.fromSeed(users.user1.seedPhrase);
      const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountPolicy = scripts.account.mint.policyId;
      const accountUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
      );
      const adminTokenName = fromText("GroupAdmin");
      const adminUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.endsWith(adminTokenName)),
      );

      yield* joinGroupTestCase(
        context,
        foundGroupUtxo!,
        accountUtxo!,
        adminUtxo!,
        100_000_000n,
        scripts,
        users.user1.seedPhrase,
      );

      const userUtxos3 = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountUtxo3 = userUtxos3.find((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
      );
      const groupUtxos3 = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupUtxo3 = groupUtxos3.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );
      const treasuryUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(scripts.treasury.spend.address),
      );
      const memberUtxo = treasuryUtxos[0];

      const result = yield* exitGroupTestCase(
        context,
        groupUtxo3!,
        accountUtxo3!,
        memberUtxo!,
        scripts,
        users.user1.seedPhrase,
      );

      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Terminate Group ---
  it.effect("should allow terminating a membership (burn)", () =>
    Effect.gen(function* () {
      const { context, scripts } = yield* setupBase();
      const { lucid, users } = context;

      yield* createGroupTestCase(context, scripts);
      yield* createAccountTestCase(context, scripts);

      const groupScriptAddr = scripts.group.spend.address;
      const groupUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupName = fromText("GroupReference");
      const foundGroupUtxo = groupUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );

      lucid.selectWallet.fromSeed(users.user1.seedPhrase);
      const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountPolicy = scripts.account.mint.policyId;
      const accountUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
      );
      const adminTokenName = fromText("GroupAdmin");
      const adminUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.endsWith(adminTokenName)),
      );

      yield* joinGroupTestCase(
        context,
        foundGroupUtxo!,
        accountUtxo!,
        adminUtxo!,
        100_000_000n,
        scripts,
        users.user1.seedPhrase,
      );

      const treasuryAddr = scripts.treasury.spend.address;
      const treasuryUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(treasuryAddr),
      );
      const memberUtxo = treasuryUtxos[0];

      const groupUtxos2 = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupUtxoRef = groupUtxos2.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );

      const unsignedTx = yield* unsignedTerminateGroupTxProgram(
        lucid,
        groupUtxoRef!,
        memberUtxo,
        scripts,
      );

      const txHash = yield* signAndSubmit(unsignedTx);
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Member Withdraw ---
  it.effect("should allow member to withdraw funds", () =>
    Effect.gen(function* () {
      const { context, scripts } = yield* setupBase();
      const { lucid, users } = context;

      yield* createGroupTestCase(context, scripts);
      yield* createAccountTestCase(context, scripts);

      const groupScriptAddr = scripts.group.spend.address;
      const groupUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupName = fromText("GroupReference");
      const foundGroupUtxo = groupUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );

      lucid.selectWallet.fromSeed(users.user1.seedPhrase);
      const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountPolicy = scripts.account.mint.policyId;
      const accountUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
      );
      const adminTokenName = fromText("GroupAdmin");
      const adminUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.endsWith(adminTokenName)),
      );

      yield* joinGroupTestCase(
        context,
        foundGroupUtxo!,
        accountUtxo!,
        adminUtxo!,
        100_000_000n,
        scripts,
        users.user1.seedPhrase,
      );

      const groupUtxos2 = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupUtxo2 = groupUtxos2.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );
      const treasuryAddr = scripts.treasury.spend.address;
      const treasuryUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(treasuryAddr),
      );
      const treasuryUtxo = treasuryUtxos[0];

      const userUtxos2 = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountUtxo2 = userUtxos2.find((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
      );

      const result = yield* memberWithdrawTestCase(
        context,
        groupUtxo2!,
        accountUtxo2!,
        treasuryUtxo,
        5_000_000n, // Withdraw 5 ADA
        scripts,
        users.user1.seedPhrase,
      );

      expect(result.txHash).toBeDefined();
      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Distribute Payout ---
  it.effect("should distribute payout to the assigned slot holder", () =>
    Effect.gen(function* () {
      const { context, scripts } = yield* setupBase();
      const { lucid, users } = context;

      yield* createGroupTestCase(context, scripts);
      yield* createAccountTestCase(context, scripts);

      const groupScriptAddr = scripts.group.spend.address;
      const groupUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupName = fromText("GroupReference");
      const foundGroupUtxo = groupUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );

      lucid.selectWallet.fromSeed(users.user1.seedPhrase);
      const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountPolicy = scripts.account.mint.policyId;
      const accountUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
      );
      const adminTokenName = fromText("GroupAdmin");
      const adminUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.endsWith(adminTokenName)),
      );

      yield* joinGroupTestCase(
        context,
        foundGroupUtxo!,
        accountUtxo!,
        adminUtxo!,
        100_000_000n,
        scripts,
        users.user1.seedPhrase,
      );

      const groupUtxos2 = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupUtxo2 = groupUtxos2.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );
      const treasuryAddr = scripts.treasury.spend.address;
      const treasuryUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(treasuryAddr),
      );

      const result = yield* distributePayoutTestCase(
        context,
        groupUtxo2!,
        treasuryUtxos,
        scripts,
        users.user1.seedPhrase,
      );

      expect(result.txHash).toBeDefined();
      expect(result.txHash).toHaveLength(64);
    }),
  );
});
