import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  CML,
  Emulator,
  generateEmulatorAccount,
  generatePrivateKey,
  Lucid,
  LucidEvolution,
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
import { BaseSetup, setupBase, setupGroup } from "./setup.js";
import {
  createAccountTestCase,
  createGroupTestCase,
  joinGroupTestCase,
  distributePayoutTestCase,
} from "./actions.js";
import { advanceBlock } from "./effects.js";
import { extractTokenSuffix } from "./utils.js";
import { accountPolicyId } from "../src/core/validators/constants.js";
import { GroupDatum } from "../src/core/types.js";

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

const expectAdminTokenAt = (
  lucid: LucidEvolution,
  address: string,
  adminUnit: string,
) =>
  Effect.gen(function* () {
    const utxos = yield* Effect.tryPromise(() => lucid.utxosAt(address));
    expect(utxos.some((u) => u.assets[adminUnit] === 1n)).toBe(true);
  });

/** Asserts the admin 222 token no longer exists anywhere on chain (burned). */
const expectAdminTokenBurned = (lucid: LucidEvolution, adminUnit: string) =>
  Effect.gen(function* () {
    // utxoByUnit either rejects or resolves undefined when no UTxO holds the unit;
    // both mean the token was burned. Resolving a real UTxO means it survived → fail.
    const result = yield* Effect.tryPromise(() =>
      lucid.utxoByUnit(adminUnit),
    ).pipe(Effect.either);
    const stillExists = result._tag === "Right" && result.right !== undefined;
    expect(stillExists).toBe(false);
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
const setupMultisigAdmin = (
  base: BaseSetup,
  groupDatumOverride?: Partial<GroupDatum>,
) =>
  Effect.gen(function* () {
    const { context } = base;
    const { lucid, users } = context;

    const { groupUtxo, groupDatum } = yield* setupGroup(
      base,
      groupDatumOverride,
    );

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

    const assignTx = yield* unsignedAssignAdminTxProgram(
      context.protocol!,
      lucid,
      {
        groupTokenSuffix,
        destinationAddress: multisig.address,
        destinationScript: multisig.script,
      },
    );
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
      Effect.either(buildMultisig(lucid, { signers: [], required: 1 })),
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
            destinationScript: multisig.script,
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
// assignAdmin destination guard: sending the 222 authority token to a script
// address is a one-way door, so the sender must prove the script is spendable
// (destinationScript hash == destination payment credential) or pass force.
// ---------------------------------------------------------------------------

describe("assignAdmin destination guard", () => {
  it.effect(
    "fails when destination is a script address without destinationScript",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context } = base;
        const { lucid, users } = context;

        const { adminUtxo } = yield* setupGroup(base);
        const groupTokenSuffix = extractTokenSuffix(
          adminUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix222,
        );
        const multisig = yield* buildMultisig(lucid, {
          signers: ["a".repeat(56), "b".repeat(56)],
          required: 2,
        });
        selectWalletFromSeed(lucid, users.admin.seedPhrase);

        const result = yield* Effect.either(
          unsignedAssignAdminTxProgram(context.protocol!, lucid, {
            groupTokenSuffix,
            destinationAddress: multisig.address,
          }),
        );
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("ConfigurationError");
        }
      }),
  );

  it.effect(
    "fails when destinationScript hash does not match the destination address",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context } = base;
        const { lucid, users } = context;

        const { adminUtxo } = yield* setupGroup(base);
        const groupTokenSuffix = extractTokenSuffix(
          adminUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix222,
        );
        const multisig = yield* buildMultisig(lucid, {
          signers: ["a".repeat(56), "b".repeat(56)],
          required: 2,
        });
        const otherMultisig = yield* buildMultisig(lucid, {
          signers: ["c".repeat(56), "d".repeat(56), "e".repeat(56)],
          required: 3,
        });
        selectWalletFromSeed(lucid, users.admin.seedPhrase);

        const result = yield* Effect.either(
          unsignedAssignAdminTxProgram(context.protocol!, lucid, {
            groupTokenSuffix,
            destinationAddress: multisig.address,
            destinationScript: otherMultisig.script,
          }),
        );
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("ConfigurationError");
        }
      }),
  );

  it.effect(
    "createGroup rejects a Script creator credential without creatorScript proof",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { lucid } = base.context;

        const multisig = yield* buildMultisig(lucid, {
          signers: ["a".repeat(56), "b".repeat(56)],
          required: 2,
        });

        const err = yield* Effect.flip(
          createGroupTestCase(base.context, {
            datumOverride: {
              creator_payment_credential: {
                Script: [multisig.policyHash] as [string],
              },
            },
            // creatorScript deliberately omitted — the guard must reject.
          }),
        );
        expect((err as { _tag?: string })._tag).toBe("ConfigurationError");
      }),
  );

  it.effect(
    "createGroup rejects a protocol script hash as creator credential",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();

        const err = yield* Effect.flip(
          createGroupTestCase(base.context, {
            datumOverride: {
              creator_payment_credential: {
                Script: [base.context.protocol!.groupPolicyId] as [string],
              },
            },
          }),
        );
        expect((err as { _tag?: string })._tag).toBe("ConfigurationError");
      }),
  );

  it.effect(
    "force: true skips destination verification for a script address",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context } = base;
        const { lucid, users } = context;

        const { adminUtxo } = yield* setupGroup(base);
        const groupTokenSuffix = extractTokenSuffix(
          adminUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix222,
        );
        const multisig = yield* buildMultisig(lucid, {
          signers: ["a".repeat(56), "b".repeat(56)],
          required: 2,
        });
        selectWalletFromSeed(lucid, users.admin.seedPhrase);

        const tx = yield* unsignedAssignAdminTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            destinationAddress: multisig.address,
            force: true,
          },
        );
        expect(tx).toBeDefined();
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
  it.effect("updateGroup: succeeds with 2-of-3 multisig admin", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const {
        context,
        groupTokenSuffix,
        groupDatum,
        multisig,
        pkA,
        pkB,
        khA,
        khB,
      } = yield* setupMultisigAdmin(base);
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const tx = yield* unsignedUpdateGroupTxProgram(context.protocol!, lucid, {
        groupTokenSuffix,
        updatedDatum: {
          ...groupDatum,
          penalty_fee: groupDatum.penalty_fee + 1_000_000n,
        },
        adminScript: multisig.script,
        adminSignerKeyHashes: [khA, khB],
      });
      const txHash = yield* signMultisigAndSubmit(tx, [pkA, pkB]);
      yield* advanceBlock(context.emulator);
      expect(txHash).toHaveLength(64);
      yield* expectAdminTokenAt(
        lucid,
        multisig.address,
        context.protocol!.groupPolicyId +
          assetNameLabels.prefix222 +
          groupTokenSuffix,
      );
    }),
  );

  it.effect(
    "updateGroup: fails with only 1-of-3 signers (quorum not met)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const {
          context,
          groupTokenSuffix,
          groupDatum,
          multisig,
          pkA,
          khA,
          khB,
        } = yield* setupMultisigAdmin(base);
        const { lucid, users } = context;

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const tx = yield* unsignedUpdateGroupTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            updatedDatum: {
              ...groupDatum,
              penalty_fee: groupDatum.penalty_fee + 1_000_000n,
            },
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          },
        );
        // Only 1 signer — native script requires 2
        const result = yield* Effect.either(signMultisigAndSubmit(tx, [pkA]));
        expect(result._tag).toBe("Left");
      }),
  );

  // --- startGroup ---
  it.effect("startGroup: succeeds with 2-of-3 multisig admin", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const {
        context,
        groupUtxo,
        groupTokenSuffix,
        multisig,
        pkA,
        pkB,
        khA,
        khB,
      } = yield* setupMultisigAdmin(base);
      const { lucid, users } = context;

      // Need 2 members to call startGroup
      const {
        outputs: { userUtxo: u1 },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const {
        outputs: { userUtxo: u2 },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: u1,
        userSeed: users.user1.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: u2,
        userSeed: users.user2.seedPhrase,
      });

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
      yield* expectAdminTokenAt(
        lucid,
        multisig.address,
        context.protocol!.groupPolicyId +
          assetNameLabels.prefix222 +
          groupTokenSuffix,
      );
    }),
  );

  it.effect("startGroup: fails with only 1-of-3 signers", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo, groupTokenSuffix, multisig, pkA, khA, khB } =
        yield* setupMultisigAdmin(base);
      const { lucid, users } = context;

      const {
        outputs: { userUtxo: u1 },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const {
        outputs: { userUtxo: u2 },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: u1,
        userSeed: users.user1.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: u2,
        userSeed: users.user2.seedPhrase,
      });

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
  it.effect("deleteGroup: succeeds with 2-of-3 multisig admin", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const {
        context,
        groupTokenSuffix,
        groupDatum,
        multisig,
        pkA,
        pkB,
        khA,
        khB,
      } = yield* setupMultisigAdmin(base);
      const { lucid, users } = context;

      // Deactivate first (also via multisig)
      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const deactivateTx = yield* unsignedUpdateGroupTxProgram(
        context.protocol!,
        lucid,
        {
          groupTokenSuffix,
          updatedDatum: { ...groupDatum, is_active: false },
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        },
      );
      yield* signMultisigAndSubmit(deactivateTx, [pkA, pkB]);
      yield* advanceBlock(context.emulator);

      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const deleteTx = yield* unsignedDeleteGroupTxProgram(
        context.protocol!,
        lucid,
        {
          groupTokenSuffix,
          scriptRefs: context.scriptRefs,
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        },
      );
      const txHash = yield* signMultisigAndSubmit(deleteTx, [pkA, pkB]);
      yield* advanceBlock(context.emulator);
      expect(txHash).toHaveLength(64);
      // closeGroup burns the admin 222 token — it must no longer exist on chain.
      yield* expectAdminTokenBurned(
        lucid,
        context.protocol!.groupPolicyId +
          assetNameLabels.prefix222 +
          groupTokenSuffix,
      );
    }),
  );

  it.effect("deleteGroup: fails with only 1-of-3 signers", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const {
        context,
        groupTokenSuffix,
        groupDatum,
        multisig,
        pkA,
        pkB,
        khA,
        khB,
      } = yield* setupMultisigAdmin(base);
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const deactivateTx = yield* unsignedUpdateGroupTxProgram(
        context.protocol!,
        lucid,
        {
          groupTokenSuffix,
          updatedDatum: { ...groupDatum, is_active: false },
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        },
      );
      yield* signMultisigAndSubmit(deactivateTx, [pkA, pkB]);
      yield* advanceBlock(context.emulator);

      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const deleteTx = yield* unsignedDeleteGroupTxProgram(
        context.protocol!,
        lucid,
        {
          groupTokenSuffix,
          scriptRefs: context.scriptRefs,
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        },
      );
      const result = yield* Effect.either(
        signMultisigAndSubmit(deleteTx, [pkA]),
      );
      expect(result._tag).toBe("Left");
    }),
  );

  // --- extendGraceWindow ---
  // interval_length: 20_000n + distribute round 0 with user1 as caller deterministically
  // pushes user1 into DefaultState (their slot-0 fee debit drops contributable to 0).
  it.effect(
    "extendGraceWindow: succeeds with 2-of-3 multisig admin (member in DefaultState)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const {
          context,
          groupUtxo,
          groupTokenSuffix,
          multisig,
          pkA,
          pkB,
          khA,
          khB,
        } = yield* setupMultisigAdmin(base, { interval_length: 20_000n });
        const { lucid, users } = context;

        const {
          outputs: { userUtxo: u1 },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: u2 },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u1,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u2,
          userSeed: users.user2.seedPhrase,
        });

        // startGroup via multisig path — admin token stays script-held through the chain.
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const startTx = yield* unsignedStartGroupTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            currentTime: BigInt(context.emulator!.now()),
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          },
        );
        yield* signMultisigAndSubmit(startTx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        // Distribute round 0 → user1 (slot 0) is debited the fee → DefaultState.
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });

        const memberAccountTokenSuffix = extractTokenSuffix(
          u1,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const tx = yield* unsignedExtendGraceWindowTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            memberAccountTokenSuffix,
            scriptRefs: context.scriptRefs,
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          },
        );
        const txHash = yield* signMultisigAndSubmit(tx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);
        expect(txHash).toHaveLength(64);
        yield* expectAdminTokenAt(
          lucid,
          multisig.address,
          context.protocol!.groupPolicyId +
            assetNameLabels.prefix222 +
            groupTokenSuffix,
        );
      }),
  );

  it.effect(
    "extendGraceWindow: fails with only 1-of-3 signers (member in DefaultState, genuine quorum)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const {
          context,
          groupUtxo,
          groupTokenSuffix,
          multisig,
          pkA,
          pkB,
          khA,
          khB,
        } = yield* setupMultisigAdmin(base, { interval_length: 20_000n });
        const { lucid, users } = context;

        const {
          outputs: { userUtxo: u1 },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: u2 },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u1,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u2,
          userSeed: users.user2.seedPhrase,
        });

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const startTx = yield* unsignedStartGroupTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            currentTime: BigInt(context.emulator!.now()),
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          },
        );
        yield* signMultisigAndSubmit(startTx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });

        const memberAccountTokenSuffix = extractTokenSuffix(
          u1,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const tx = yield* unsignedExtendGraceWindowTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            memberAccountTokenSuffix,
            scriptRefs: context.scriptRefs,
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          },
        );
        // Build succeeded (member IS in DefaultState); signing with only 1 of 2 required
        // co-signers must be rejected by the native-script quorum check.
        const submitResult = yield* Effect.either(
          signMultisigAndSubmit(tx, [pkA]),
        );
        expect(submitResult._tag).toBe("Left");
      }),
  );

  // --- terminateDefault ---
  it.effect(
    "terminateDefault: succeeds with 2-of-3 multisig admin (member in DefaultState)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const {
          context,
          groupUtxo,
          groupTokenSuffix,
          multisig,
          pkA,
          pkB,
          khA,
          khB,
        } = yield* setupMultisigAdmin(base, { interval_length: 20_000n });
        const { lucid, users } = context;

        const {
          outputs: { userUtxo: u1 },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: u2 },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u1,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u2,
          userSeed: users.user2.seedPhrase,
        });

        // startGroup via multisig path — admin token stays script-held through the chain.
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const startTx = yield* unsignedStartGroupTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            currentTime: BigInt(context.emulator!.now()),
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          },
        );
        yield* signMultisigAndSubmit(startTx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        // Distribute round 0 → user1 (slot 0) debited the fee → DefaultState (grace_period_length
        // default 0, so grace expires at the round timestamp).
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });
        // Advance past grace_expires_at so the termination time-gate opens.
        yield* advanceBlock(context.emulator, 2);
        const currentTime = BigInt(context.emulator!.now());

        const memberAccountTokenSuffix = extractTokenSuffix(
          u1,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const tx = yield* unsignedTerminateDefaultTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            memberAccountTokenSuffix,
            currentTime,
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
            scriptRefs: context.scriptRefs,
          },
        );
        const txHash = yield* signMultisigAndSubmit(tx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);
        expect(txHash).toHaveLength(64);
        yield* expectAdminTokenAt(
          lucid,
          multisig.address,
          context.protocol!.groupPolicyId +
            assetNameLabels.prefix222 +
            groupTokenSuffix,
        );
      }),
  );

  it.effect(
    "terminateDefault: fails with only 1-of-3 signers (member in DefaultState, genuine quorum)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const {
          context,
          groupUtxo,
          groupTokenSuffix,
          multisig,
          pkA,
          pkB,
          khA,
          khB,
        } = yield* setupMultisigAdmin(base, { interval_length: 20_000n });
        const { lucid, users } = context;

        const {
          outputs: { userUtxo: u1 },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: u2 },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u1,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u2,
          userSeed: users.user2.seedPhrase,
        });

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const startTx = yield* unsignedStartGroupTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            currentTime: BigInt(context.emulator!.now()),
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          },
        );
        yield* signMultisigAndSubmit(startTx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);

        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });
        yield* advanceBlock(context.emulator, 2);
        const currentTime = BigInt(context.emulator!.now());

        const memberAccountTokenSuffix = extractTokenSuffix(
          u1,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const tx = yield* unsignedTerminateDefaultTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            memberAccountTokenSuffix,
            currentTime,
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
            scriptRefs: context.scriptRefs,
          },
        );
        // Build succeeded (member IS in DefaultState past grace); 1-of-2 signing must be
        // rejected by the native-script quorum check.
        const submitResult = yield* Effect.either(
          signMultisigAndSubmit(tx, [pkA]),
        );
        expect(submitResult._tag).toBe("Left");
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

        const {
          outputs: { userUtxo: u1 },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: u2 },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        const groupRefUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix100 +
          groupTokenSuffix;
        const groupUtxo2 = yield* Effect.promise<UTxO>(() =>
          lucid.utxoByUnit(groupRefUnit),
        );

        yield* joinGroupTestCase(context, {
          groupUtxo: groupUtxo2,
          accountUtxo: u1,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo: groupUtxo2,
          accountUtxo: u2,
          userSeed: users.user2.seedPhrase,
        });

        // startGroup via multisig path — admin token is at script address after setupMultisigAdmin
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const startTx5 = yield* unsignedStartGroupTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            currentTime: BigInt(context.emulator!.now()),
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          },
        );
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
        const exitTx = yield* unsignedExitGroupTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            accountTokenSuffix: memberAccountTokenSuffix,
            currentTime,
            scriptRefs: context.scriptRefs,
          },
        );
        yield* signAndSubmit(exitTx);
        yield* advanceBlock(context.emulator);

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const terminateTx = yield* unsignedTerminateGroupTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            memberAccountTokenSuffix,
            scriptRefs: context.scriptRefs,
            adminScript: multisig.script,
            adminSignerKeyHashes: [khA, khB],
          },
        );
        const txHash = yield* signMultisigAndSubmit(terminateTx, [pkA, pkB]);
        yield* advanceBlock(context.emulator);
        expect(txHash).toHaveLength(64);
        yield* expectAdminTokenAt(
          lucid,
          multisig.address,
          context.protocol!.groupPolicyId +
            assetNameLabels.prefix222 +
            groupTokenSuffix,
        );
      }),
  );

  it.effect("terminateGroup: fails with only 1-of-3 signers", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupTokenSuffix, multisig, pkA, pkB, khA, khB } =
        yield* setupMultisigAdmin(base);
      const { lucid, users } = context;

      const {
        outputs: { userUtxo: u1 },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const {
        outputs: { userUtxo: u2 },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });

      const groupRefUnit =
        context.protocol!.groupPolicyId +
        assetNameLabels.prefix100 +
        groupTokenSuffix;
      const groupUtxo2 = yield* Effect.promise<UTxO>(() =>
        lucid.utxoByUnit(groupRefUnit),
      );

      yield* joinGroupTestCase(context, {
        groupUtxo: groupUtxo2,
        accountUtxo: u1,
        userSeed: users.user1.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo: groupUtxo2,
        accountUtxo: u2,
        userSeed: users.user2.seedPhrase,
      });

      // startGroup via multisig path — admin token is at script address after setupMultisigAdmin
      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const startTx6 = yield* unsignedStartGroupTxProgram(
        context.protocol!,
        lucid,
        {
          groupTokenSuffix,
          currentTime: BigInt(context.emulator!.now()),
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        },
      );
      yield* signMultisigAndSubmit(startTx6, [pkA, pkB]);
      yield* advanceBlock(context.emulator);

      const currentTime = BigInt(context.emulator!.now());
      const memberAccountTokenSuffix = extractTokenSuffix(
        u1,
        accountPolicyId,
        assetNameLabels.prefix222,
      );
      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const exitTx = yield* unsignedExitGroupTxProgram(
        context.protocol!,
        lucid,
        {
          groupTokenSuffix,
          accountTokenSuffix: memberAccountTokenSuffix,
          currentTime,
          scriptRefs: context.scriptRefs,
        },
      );
      yield* signAndSubmit(exitTx);
      yield* advanceBlock(context.emulator);

      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const terminateTx = yield* unsignedTerminateGroupTxProgram(
        context.protocol!,
        lucid,
        {
          groupTokenSuffix,
          memberAccountTokenSuffix,
          scriptRefs: context.scriptRefs,
          adminScript: multisig.script,
          adminSignerKeyHashes: [khA, khB],
        },
      );
      const result = yield* Effect.either(
        signMultisigAndSubmit(terminateTx, [pkA]),
      );
      expect(result._tag).toBe("Left");
    }),
  );
});
