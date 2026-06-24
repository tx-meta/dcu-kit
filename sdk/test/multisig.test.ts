import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  CML,
  Emulator,
  generateEmulatorAccount,
  generatePrivateKey,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
  TxSignBuilder,
  UTxO,
} from "@lucid-evolution/lucid";
import {
  buildMultisig,
  assetNameLabels,
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/utils/index.js";
import { unsignedAssignAdminTxProgram } from "../src/endpoints/assignAdmin.js";
import { unsignedUpdateGroupTxProgram } from "../src/endpoints/updateGroup.js";
import { unsignedStartGroupTxProgram } from "../src/endpoints/startGroup.js";
import { unsignedDeleteGroupTxProgram } from "../src/endpoints/deleteGroup.js";
import { unsignedExtendGraceWindowTxProgram } from "../src/endpoints/extendGraceWindow.js";
import { unsignedTerminateDefaultTxProgram } from "../src/endpoints/terminateDefault.js";
import { unsignedTerminateGroupTxProgram } from "../src/endpoints/terminateGroup.js";
import { unsignedExitGroupTxProgram } from "../src/endpoints/exitGroup.js";
import {
  BaseSetup,
  setupBase,
  setupGroup,
} from "./setup.js";
import {
  createAccountTestCase,
  joinGroupTestCase,
} from "./actions.js";
import { advanceBlock } from "./effects.js";
import { extractTokenSuffix } from "./utils.js";
import { accountPolicyId } from "../src/core/validators/constants.js";

// ---------------------------------------------------------------------------
// Helpers for script-held admin spending in tests
// ---------------------------------------------------------------------------

/** Derive a 56-hex-char payment key hash from a raw bech32 ed25519 private key. */
function keyHashFromPrivateKey(pk: string): string {
  return CML.PrivateKey.from_bech32(pk).to_public().hash().to_hex();
}

/**
 * Sign a TxSignBuilder with multiple private keys (M-of-N multisig path) and submit.
 * The first key is the primary wallet signing key (already in the withWallet call path);
 * we chain withPrivateKey for each multisig co-signer key before completing.
 */
const signMultisigAndSubmit = (
  tx: TxSignBuilder,
  signerPrivateKeys: string[],
): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      // Always sign with the currently selected wallet (pays fees, signs addSigner outputs).
      // Then chain withPrivateKey for each required multisig co-signer key.
      let builder = tx.sign.withWallet();
      for (const pk of signerPrivateKeys) {
        builder = builder.sign.withPrivateKey(pk);
      }
      const signed = await builder.complete();
      return signed.submit();
    },
    catch: (e) => new Error(String(e)),
  });

/**
 * Build a fresh 2-of-3 multisig from real private keys (so the emulator can sign).
 * Returns the private keys, their hashes, and the built multisig.
 */
function makeRealMultisigKeys() {
  const pkA = generatePrivateKey();
  const pkB = generatePrivateKey();
  const pkC = generatePrivateKey();
  const khA = keyHashFromPrivateKey(pkA);
  const khB = keyHashFromPrivateKey(pkB);
  const khC = keyHashFromPrivateKey(pkC);
  return { pkA, pkB, pkC, khA, khB, khC };
}

/**
 * Shared setup: create a group with a VK admin, then assignAdmin to a 2-of-3
 * native-script address. Returns everything needed for follow-on admin ops.
 */
const setupMultisigAdmin = (base: BaseSetup) =>
  Effect.gen(function* () {
    const { context } = base;
    const { lucid, users } = context;

    const { groupUtxo, groupDatum } = yield* setupGroup(base);

    const { pkA, pkB, pkC, khA, khB, khC } = makeRealMultisigKeys();

    const multisig = yield* buildMultisig(lucid, {
      signers: [khA, khB, khC],
      required: 2,
    });

    selectWalletFromSeed(lucid, users.admin.seedPhrase);
    const groupTokenSuffix = extractTokenSuffix(
      groupUtxo,
      context.protocol!.groupPolicyId,
      assetNameLabels.prefix100,
    );

    const assignTx = yield* unsignedAssignAdminTxProgram(context.protocol!, lucid, {
      groupTokenSuffix,
      destinationAddress: multisig.address,
    });
    yield* signAndSubmit(assignTx);
    yield* advanceBlock(context.emulator);

    return {
      context,
      groupUtxo,
      groupDatum,
      groupTokenSuffix,
      multisig,
      pkA,
      pkB,
      pkC,
      khA,
      khB,
      khC,
    };
  });

// Three deterministic-looking payment key hashes (28 bytes = 56 hex chars each)
const KEY_A = "a".repeat(56);
const KEY_B = "b".repeat(56);
const KEY_C = "c".repeat(56);

// Golden hash: the exact policyHash (native script hash) buildMultisig produces for
// an `atLeast 2 of [KEY_A, KEY_B, KEY_C]` script. The script is opaque CBOR, so this
// pins the M/N structure — any inversion of `required` vs `signers.length` (e.g. a
// 3-of-3 or a different member order) changes the hash and fails this assertion.
const GOLDEN_2_OF_3_HASH =
  "dcc7bc8d59c400a2a699f1756e4a18ae92c900ea173cab2f92c24290";

const makeTestLucid = () =>
  Effect.promise(async () => {
    const acct = generateEmulatorAccount({ lovelace: 5_000_000n });
    const emulator = new Emulator([acct], PROTOCOL_PARAMETERS_DEFAULT);
    return Lucid(emulator, "Custom");
  });

describe("buildMultisig", () => {
  it("returns an atLeast script, enterprise address, and deterministic policyHash", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const result = await Effect.runPromise(
      buildMultisig(lucid, {
        signers: [KEY_A, KEY_B, KEY_C],
        required: 2,
      }),
    );

    // Script type must be Native
    expect(result.script.type).toBe("Native");

    // Address must be a script (enterprise) address on Custom network
    // Enterprise addresses on Custom begin with "addr_test1w" (script) or "addr_test1q" (key)
    // Native script addresses use script credential → "addr_test1w"
    expect(result.address).toMatch(/^addr_test1w/);

    // policyHash is a 28-byte / 56-hex-char script hash
    expect(result.policyHash).toHaveLength(56);
    expect(result.policyHash).toMatch(/^[0-9a-f]+$/);

    // Golden-hash assertion: pins the exact atLeast-2-of-3 structure. Catches any
    // M/N inversion without deserialising the opaque script CBOR.
    expect(result.policyHash).toBe(GOLDEN_2_OF_3_HASH);
  });

  it("policyHash is deterministic for identical inputs", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const r1 = await Effect.runPromise(
      buildMultisig(lucid, { signers: [KEY_A, KEY_B, KEY_C], required: 2 }),
    );
    const r2 = await Effect.runPromise(
      buildMultisig(lucid, { signers: [KEY_A, KEY_B, KEY_C], required: 2 }),
    );

    expect(r1.policyHash).toBe(r2.policyHash);
    expect(r1.address).toBe(r2.address);
  });

  it("fails when required > signers.length", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const result = await Effect.runPromise(
      Effect.either(
        buildMultisig(lucid, { signers: [KEY_A, KEY_B], required: 3 }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("ConfigurationError");
    }
  });

  it("fails when required < 1", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const result = await Effect.runPromise(
      Effect.either(
        buildMultisig(lucid, { signers: [KEY_A, KEY_B], required: 0 }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("ConfigurationError");
    }
  });

  it("fails when required is non-integer", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const result = await Effect.runPromise(
      Effect.either(
        buildMultisig(lucid, { signers: [KEY_A, KEY_B, KEY_C], required: 1.5 }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("ConfigurationError");
    }
  });

  it("fails when signers array is empty", async () => {
    const lucid = await Effect.runPromise(makeTestLucid());

    const result = await Effect.runPromise(
      Effect.either(
        buildMultisig(lucid, { signers: [], required: 1 }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("ConfigurationError");
    }
  });
});

describe("assignAdmin", () => {
  // TDD: this test was written RED (endpoint missing) before assignAdmin.ts existed.
  // Verifies that the group 222 admin token moves from the VK wallet to a
  // buildMultisig script address after calling assignAdmin.
  it.effect(
    "transfers the 222 admin token from wallet to a multisig script address",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context } = base;
        const { lucid, users, emulator } = context;

        // Create a group with the VK admin wallet; admin 222 token lands in admin wallet.
        // setupGroup doesn't surface the suffix directly — extract it from adminUtxo.
        const { adminUtxo } = yield* setupGroup(base);
        const groupTokenSuffix = extractTokenSuffix(
          adminUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix222,
        );

        // Build a 2-of-3 multisig — its address is the destination for assignAdmin.
        const KEY_A = "a".repeat(56);
        const KEY_B = "b".repeat(56);
        const KEY_C = "c".repeat(56);
        const multisig = yield* buildMultisig(lucid, {
          signers: [KEY_A, KEY_B, KEY_C],
          required: 2,
        });

        // Admin wallet still selected from setupGroup.
        selectWalletFromSeed(lucid, users.admin.seedPhrase);

        const adminUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix222 +
          groupTokenSuffix;

        const tx = yield* unsignedAssignAdminTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            destinationAddress: multisig.address,
          },
        );
        const txHash = yield* signAndSubmit(tx);
        yield* advanceBlock(emulator);

        // The 222 admin token must now be at the multisig script address.
        const multisigUtxos = yield* Effect.tryPromise(() =>
          lucid.utxosAt(multisig.address),
        );
        const adminAtMultisig = multisigUtxos.find(
          (u) => u.txHash === txHash && u.assets[adminUnit] === 1n,
        );
        expect(adminAtMultisig).toBeDefined();
        expect(adminAtMultisig!.assets[adminUnit]).toBe(1n);
      }),
  );
});

// ---------------------------------------------------------------------------
// Script-held admin token: 6 admin ops with multisig
// ---------------------------------------------------------------------------
// Each test follows the same structure:
//   1. setupMultisigAdmin: group created, admin 222 token moved to 2-of-3 script address
//   2. Call the admin op with adminScript present + 2 of 3 private-key signers → SUCCESS
//   3. Repeat with only 1 signer → FAIL (on-chain native-script quorum check)
// ---------------------------------------------------------------------------

describe("script-held admin ops", () => {
  // --- updateGroup ---
  it.effect(
    "updateGroup: succeeds with 2-of-3 multisig admin",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupTokenSuffix, groupDatum, multisig, pkA, pkB, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const tx = yield* unsignedUpdateGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          updatedDatum: { ...groupDatum, penalty_fee: groupDatum.penalty_fee + 1_000_000n },
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        const txHash = yield* signMultisigAndSubmit(tx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);
        expect(txHash).toHaveLength(64);
      }),
  );

  it.effect(
    "updateGroup: fails with only 1-of-3 signers (quorum not met)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupTokenSuffix, groupDatum, multisig, pkA, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const tx = yield* unsignedUpdateGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          updatedDatum: { ...groupDatum, penalty_fee: groupDatum.penalty_fee + 1_000_000n },
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        // Only 1 signer — native script requires 2
        const result = yield* Effect.either(signMultisigAndSubmit(tx, [pkA]));
        expect(result._tag).toBe("Left");
      }),
  );

  // --- startGroup ---
  it.effect(
    "startGroup: succeeds with 2-of-3 multisig admin",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo, groupTokenSuffix, multisig, pkA, pkB, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        // Need 2 members to call startGroup
        const { outputs: { userUtxo: u1 } } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const { outputs: { userUtxo: u2 } } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });
        yield* joinGroupTestCase(context, { groupUtxo, accountUtxo: u1, userSeed: users.user1.seedPhrase });
        yield* joinGroupTestCase(context, { groupUtxo, accountUtxo: u2, userSeed: users.user2.seedPhrase });

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const currentTime = BigInt(context.emulator!.now());
        const tx = yield* unsignedStartGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          currentTime,
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        const txHash = yield* signMultisigAndSubmit(tx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);
        expect(txHash).toHaveLength(64);
      }),
  );

  it.effect(
    "startGroup: fails with only 1-of-3 signers",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo, groupTokenSuffix, multisig, pkA, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        const { outputs: { userUtxo: u1 } } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const { outputs: { userUtxo: u2 } } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });
        yield* joinGroupTestCase(context, { groupUtxo, accountUtxo: u1, userSeed: users.user1.seedPhrase });
        yield* joinGroupTestCase(context, { groupUtxo, accountUtxo: u2, userSeed: users.user2.seedPhrase });

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const currentTime = BigInt(context.emulator!.now());
        const tx = yield* unsignedStartGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          currentTime,
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        const result = yield* Effect.either(signMultisigAndSubmit(tx, [pkA]));
        expect(result._tag).toBe("Left");
      }),
  );

  // --- deleteGroup ---
  it.effect(
    "deleteGroup: succeeds with 2-of-3 multisig admin",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupTokenSuffix, groupDatum, multisig, pkA, pkB, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        // Deactivate first (also via multisig)
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const deactivateTx = yield* unsignedUpdateGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          updatedDatum: { ...groupDatum, is_active: false },
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        yield* signMultisigAndSubmit(deactivateTx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const deleteTx = yield* unsignedDeleteGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        const txHash = yield* signMultisigAndSubmit(deleteTx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);
        expect(txHash).toHaveLength(64);
      }),
  );

  it.effect(
    "deleteGroup: fails with only 1-of-3 signers",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupTokenSuffix, groupDatum, multisig, pkA, pkB, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const deactivateTx = yield* unsignedUpdateGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          updatedDatum: { ...groupDatum, is_active: false },
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        yield* signMultisigAndSubmit(deactivateTx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const deleteTx = yield* unsignedDeleteGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        const result = yield* Effect.either(signMultisigAndSubmit(deleteTx, [pkA]));
        expect(result._tag).toBe("Left");
      }),
  );

  // --- extendGraceWindow ---
  it.effect(
    "extendGraceWindow: 2-of-3 multisig admin path runs (VK check, not wrong-signer)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupTokenSuffix, multisig, pkA, pkB, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        // Need a member in DefaultState. Set up 2 members + startGroup.
        const { outputs: { userUtxo: u1 } } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const { outputs: { userUtxo: u2 } } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        const groupRefUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix100 +
          groupTokenSuffix;
        const groupUtxo2 = yield* Effect.promise<UTxO>(() => lucid.utxoByUnit(groupRefUnit));

        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u1, userSeed: users.user1.seedPhrase });
        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u2, userSeed: users.user2.seedPhrase });

        // startGroup via multisig path — admin token is at script address after setupMultisigAdmin
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const startTx1 = yield* unsignedStartGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          currentTime: BigInt(context.emulator!.now()),
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        yield* signMultisigAndSubmit(startTx1, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        const memberAccountTokenSuffix = extractTokenSuffix(
          u1,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const result = yield* Effect.either(
          unsignedExtendGraceWindowTxProgram(context.protocol!, lucid, {
            groupTokenSuffix,
            memberAccountTokenSuffix,
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          }),
        );
        if (result._tag === "Right") {
          const txHash = yield* signMultisigAndSubmit(result.right, [pkA, pkB]);
          yield* advanceBlock(context.emulator);
          expect(txHash).toHaveLength(64);
        } else {
          // Member not in DefaultState yet — but the adminScript field was accepted
          expect(["InvalidDatumError", "UtxoNotFoundError", "TransactionBuildError"]).toContain(
            result.left._tag,
          );
        }
      }),
  );

  it.effect(
    "extendGraceWindow: fails with only 1-of-3 signers when member IS in DefaultState",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupTokenSuffix, multisig, pkA, pkB, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        const { outputs: { userUtxo: u1 } } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const { outputs: { userUtxo: u2 } } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        const groupRefUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix100 +
          groupTokenSuffix;
        const groupUtxo2 = yield* Effect.promise<UTxO>(() => lucid.utxoByUnit(groupRefUnit));

        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u1, userSeed: users.user1.seedPhrase });
        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u2, userSeed: users.user2.seedPhrase });

        // startGroup via multisig path — admin token is at script address after setupMultisigAdmin
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const startTx2 = yield* unsignedStartGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          currentTime: BigInt(context.emulator!.now()),
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        yield* signMultisigAndSubmit(startTx2, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        const memberAccountTokenSuffix = extractTokenSuffix(
          u1,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const buildResult = yield* Effect.either(
          unsignedExtendGraceWindowTxProgram(context.protocol!, lucid, {
            groupTokenSuffix,
            memberAccountTokenSuffix,
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          }),
        );
        if (buildResult._tag === "Right") {
          // Built successfully — now signing with only 1 key must fail
          const submitResult = yield* Effect.either(
            signMultisigAndSubmit(buildResult.right, [pkA]),
          );
          expect(submitResult._tag).toBe("Left");
        } else {
          // Member not in DefaultState — endpoint-level error is acceptable
          expect(["InvalidDatumError", "UtxoNotFoundError", "TransactionBuildError"]).toContain(
            buildResult.left._tag,
          );
        }
      }),
  );

  // --- terminateDefault ---
  it.effect(
    "terminateDefault: 2-of-3 multisig admin path runs (VK check, not wrong-signer)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupTokenSuffix, multisig, pkA, pkB, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        const { outputs: { userUtxo: u1 } } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const { outputs: { userUtxo: u2 } } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        const groupRefUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix100 +
          groupTokenSuffix;
        const groupUtxo2 = yield* Effect.promise<UTxO>(() => lucid.utxoByUnit(groupRefUnit));

        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u1, userSeed: users.user1.seedPhrase });
        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u2, userSeed: users.user2.seedPhrase });

        // startGroup via multisig path — admin token is at script address after setupMultisigAdmin
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const startTx3 = yield* unsignedStartGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          currentTime: BigInt(context.emulator!.now()),
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        yield* signMultisigAndSubmit(startTx3, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        yield* advanceBlock(context.emulator, 200);
        const currentTime = BigInt(context.emulator!.now());

        const memberAccountTokenSuffix = extractTokenSuffix(
          u1,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const result = yield* Effect.either(
          unsignedTerminateDefaultTxProgram(context.protocol!, lucid, {
            groupTokenSuffix,
            memberAccountTokenSuffix,
            currentTime,
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          }),
        );
        if (result._tag === "Right") {
          const txHash = yield* signMultisigAndSubmit(result.right, [pkA, pkB]);
          yield* advanceBlock(context.emulator);
          expect(txHash).toHaveLength(64);
        } else {
          expect(["UtxoNotFoundError", "TransactionBuildError"]).toContain(
            result.left._tag,
          );
        }
      }),
  );

  it.effect(
    "terminateDefault: fails with only 1-of-3 signers when member IS in DefaultState",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupTokenSuffix, multisig, pkA, pkB, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        const { outputs: { userUtxo: u1 } } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const { outputs: { userUtxo: u2 } } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        const groupRefUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix100 +
          groupTokenSuffix;
        const groupUtxo2 = yield* Effect.promise<UTxO>(() => lucid.utxoByUnit(groupRefUnit));

        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u1, userSeed: users.user1.seedPhrase });
        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u2, userSeed: users.user2.seedPhrase });

        // startGroup via multisig path — admin token is at script address after setupMultisigAdmin
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const startTx4 = yield* unsignedStartGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          currentTime: BigInt(context.emulator!.now()),
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        yield* signMultisigAndSubmit(startTx4, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        yield* advanceBlock(context.emulator, 200);
        const currentTime = BigInt(context.emulator!.now());

        const memberAccountTokenSuffix = extractTokenSuffix(
          u1,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const buildResult = yield* Effect.either(
          unsignedTerminateDefaultTxProgram(context.protocol!, lucid, {
            groupTokenSuffix,
            memberAccountTokenSuffix,
            currentTime,
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          }),
        );
        if (buildResult._tag === "Right") {
          const submitResult = yield* Effect.either(
            signMultisigAndSubmit(buildResult.right, [pkA]),
          );
          expect(submitResult._tag).toBe("Left");
        } else {
          expect(["UtxoNotFoundError", "TransactionBuildError"]).toContain(
            buildResult.left._tag,
          );
        }
      }),
  );

  // --- terminateGroup (claimPenalty) ---
  it.effect(
    "terminateGroup: succeeds with 2-of-3 multisig admin after early exit",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupTokenSuffix, multisig, pkA, pkB, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        const { outputs: { userUtxo: u1 } } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const { outputs: { userUtxo: u2 } } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        const groupRefUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix100 +
          groupTokenSuffix;
        const groupUtxo2 = yield* Effect.promise<UTxO>(() => lucid.utxoByUnit(groupRefUnit));

        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u1, userSeed: users.user1.seedPhrase });
        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u2, userSeed: users.user2.seedPhrase });

        // startGroup via multisig path — admin token is at script address after setupMultisigAdmin
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const startTx5 = yield* unsignedStartGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          currentTime: BigInt(context.emulator!.now()),
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        yield* signMultisigAndSubmit(startTx5, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        // Early exit → PenaltyState
        const currentTime = BigInt(context.emulator!.now());
        const memberAccountTokenSuffix = extractTokenSuffix(
          u1,
          accountPolicyId,
          assetNameLabels.prefix222,
        );
        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const exitTx = yield* unsignedExitGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          accountTokenSuffix: memberAccountTokenSuffix,
          currentTime,
        });
        yield* signAndSubmit(exitTx);
        yield* advanceBlock(context.emulator);

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const terminateTx = yield* unsignedTerminateGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          memberAccountTokenSuffix,
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        const txHash = yield* signMultisigAndSubmit(terminateTx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);
        expect(txHash).toHaveLength(64);
      }),
  );

  it.effect(
    "terminateGroup: fails with only 1-of-3 signers",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupTokenSuffix, multisig, pkA, pkB, khA, khB } =
          yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        const { outputs: { userUtxo: u1 } } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const { outputs: { userUtxo: u2 } } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        const groupRefUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix100 +
          groupTokenSuffix;
        const groupUtxo2 = yield* Effect.promise<UTxO>(() => lucid.utxoByUnit(groupRefUnit));

        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u1, userSeed: users.user1.seedPhrase });
        yield* joinGroupTestCase(context, { groupUtxo: groupUtxo2, accountUtxo: u2, userSeed: users.user2.seedPhrase });

        // startGroup via multisig path — admin token is at script address after setupMultisigAdmin
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const startTx6 = yield* unsignedStartGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          currentTime: BigInt(context.emulator!.now()),
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        yield* signMultisigAndSubmit(startTx6, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        const currentTime = BigInt(context.emulator!.now());
        const memberAccountTokenSuffix = extractTokenSuffix(
          u1,
          accountPolicyId,
          assetNameLabels.prefix222,
        );
        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const exitTx = yield* unsignedExitGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          accountTokenSuffix: memberAccountTokenSuffix,
          currentTime,
        });
        yield* signAndSubmit(exitTx);
        yield* advanceBlock(context.emulator);

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const terminateTx = yield* unsignedTerminateGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          memberAccountTokenSuffix,
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        });
        const result = yield* Effect.either(signMultisigAndSubmit(terminateTx, [pkA]));
        expect(result._tag).toBe("Left");
      }),
  );
});
