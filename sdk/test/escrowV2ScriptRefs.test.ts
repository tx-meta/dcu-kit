import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  Emulator,
  generateEmulatorAccount,
  generatePrivateKey,
  Lucid,
  LucidEvolution,
  PROTOCOL_PARAMETERS_DEFAULT,
  UTxO,
} from "@lucid-evolution/lucid";
import {
  hashContent,
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/utils/index.js";
import { deployModuleScripts } from "../src/admin/deployModuleScripts.js";
import { unsignedCreateEscrowV2TxProgram } from "../src/escrow/v2/endpoints/createEscrow.js";
import { unsignedReleaseMilestoneV2TxProgram } from "../src/escrow/v2/endpoints/releaseMilestone.js";
import { unsignedSubmitEvidenceTxProgram } from "../src/escrow/v2/endpoints/submitEvidence.js";
import { unsignedCreatePoolTxProgram } from "../src/escrow/v2/endpoints/createPool.js";
import { unsignedDepositToPoolTxProgram } from "../src/escrow/v2/endpoints/depositToPool.js";
import { unsignedAllocateToEscrowTxProgram } from "../src/escrow/v2/endpoints/allocateToEscrow.js";
import { getEscrowStateProgram } from "../src/escrow/v2/queries/getEscrowState.js";
import { getPoolEscrowsProgram } from "../src/escrow/v2/queries/getPoolEscrows.js";
import {
  clearEscrowV2ReferenceScripts,
  configureEscrowV2ReferenceScripts,
  EscrowV2ScriptRefs,
  verifyEscrowV2ScriptRefs,
} from "../src/escrow/v2/scriptRefs.js";
import {
  escrowV2Validator,
  poolVaultValidator,
} from "../src/escrow/v2/validators.js";
import { advanceBlock } from "./effects.js";

const HOUR = 3_600_000n;

type Ctx = {
  lucid: LucidEvolution;
  emulator: Emulator;
  funder: { seedPhrase: string; address: string };
  beneficiary: { privateKey: string; address: string };
  verifier: { privateKey: string; address: string };
  escrowRef: UTxO;
  poolRef: UTxO;
};

const keyWallet = (emulator: Emulator) =>
  Effect.promise(async () => {
    const privateKey = generatePrivateKey();
    const l = await Lucid(emulator, "Custom");
    l.selectWallet.fromPrivateKey(privateKey);
    return { privateKey, address: await l.wallet().address() };
  });

/**
 * A context whose escrow and pool validators are already published as
 * reference scripts, so the endpoints below take the `readFrom` path. The rest
 * of the v2 suite covers the inline path; every config mode is its own code
 * path and needs its own round trip.
 */
const makeContext = Effect.gen(function* () {
  const funder = generateEmulatorAccount({ lovelace: 5_000_000_000n });
  const emulator = new Emulator([funder], PROTOCOL_PARAMETERS_DEFAULT);
  const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));

  const beneficiary = yield* keyWallet(emulator);
  const verifier = yield* keyWallet(emulator);

  selectWalletFromSeed(lucid, funder.seedPhrase);
  const fundTx = yield* Effect.promise(() =>
    lucid
      .newTx()
      .pay.ToAddress(beneficiary.address, { lovelace: 200_000_000n })
      .pay.ToAddress(verifier.address, { lovelace: 200_000_000n })
      .complete(),
  );
  yield* signAndSubmit(fundTx);
  yield* advanceBlock(emulator);

  const deployed = yield* deployModuleScripts(
    {
      escrowV2: escrowV2Validator.spendEscrow,
      pool: poolVaultValidator.spendPool,
    },
    lucid,
    { awaitSettled: () => advanceBlock(emulator) },
  ).pipe(Effect.orDie);
  const [escrowRef, poolRef] = yield* Effect.promise(() =>
    lucid.utxosByOutRef([deployed.refs.escrowV2!, deployed.refs.pool!]),
  ).pipe(
    Effect.map((utxos) => [
      utxos.find((u) => u.txHash === deployed.refs.escrowV2!.txHash) as UTxO,
      utxos.find((u) => u.txHash === deployed.refs.pool!.txHash) as UTxO,
    ]),
  );

  selectWalletFromSeed(lucid, funder.seedPhrase);
  return { lucid, emulator, funder, beneficiary, verifier, escrowRef, poolRef };
});

const createEscrow = (ctx: Ctx, scriptRefs?: EscrowV2ScriptRefs) =>
  Effect.gen(function* () {
    selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
    const now = BigInt(ctx.emulator.now());
    const { tx, stateTokenName } = yield* unsignedCreateEscrowV2TxProgram(
      ctx.lucid,
      {
        beneficiaryAddress: ctx.beneficiary.address,
        verifier: ctx.verifier.address,
        milestones: [
          { amount: 40_000_000n, deadline: now + 1n * HOUR },
          { amount: 20_000_000n, deadline: now + 2n * HOUR },
        ],
        grace: HOUR,
        fundingMode: "Upfront",
        timeoutPolicy: "RefundToFunder",
        title: "reference-script run",
        currentTime: now,
        scriptRefs,
      },
    );
    yield* signAndSubmit(tx);
    yield* advanceBlock(ctx.emulator);
    return stateTokenName;
  });

describe("escrow v2 reference-script path (emulator)", () => {
  it.effect(
    "runs mint, spend and burn witnessing the script from a reference",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const scriptRefs = { escrow: ctx.escrowRef };

        const stateTokenName = yield* createEscrow(ctx, scriptRefs);

        ctx.lucid.selectWallet.fromPrivateKey(ctx.beneficiary.privateKey);
        const evidenceTx = yield* unsignedSubmitEvidenceTxProgram(ctx.lucid, {
          stateTokenName,
          milestoneIndex: 0,
          evidenceHash: hashContent("delivered"),
          scriptRefs,
        });
        yield* signAndSubmit(evidenceTx);
        yield* advanceBlock(ctx.emulator);

        // The last release burns the state token, so the reference input has
        // to cover the mint purpose as well as the spend.
        for (let i = 0; i < 2; i++) {
          ctx.lucid.selectWallet.fromPrivateKey(ctx.verifier.privateKey);
          const tx = yield* unsignedReleaseMilestoneV2TxProgram(ctx.lucid, {
            stateTokenName,
            currentTime: BigInt(ctx.emulator.now()),
            scriptRefs,
          });
          yield* signAndSubmit(tx);
          yield* advanceBlock(ctx.emulator);
        }

        const gone = yield* Effect.either(
          getEscrowStateProgram(ctx.lucid, { stateTokenName }),
        );
        expect(gone._tag).toBe("Left");
      }),
  );

  it.effect("allocates from a pool using both reference scripts", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const scriptRefs = { escrow: ctx.escrowRef, pool: ctx.poolRef };

      selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
      const { tx: poolTx, poolTokenName } = yield* unsignedCreatePoolTxProgram(
        ctx.lucid,
        { title: "ref pool", scriptRefs },
      );
      yield* signAndSubmit(poolTx);
      yield* advanceBlock(ctx.emulator);

      const depositTx = yield* unsignedDepositToPoolTxProgram(ctx.lucid, {
        poolTokenName,
        amount: 120_000_000n,
      });
      yield* signAndSubmit(depositTx);
      yield* advanceBlock(ctx.emulator);

      const allocNow = BigInt(ctx.emulator.now());
      const { tx: allocTx } = yield* unsignedAllocateToEscrowTxProgram(
        ctx.lucid,
        {
          poolTokenName,
          newEscrow: {
            beneficiaryAddress: ctx.beneficiary.address,
            verifier: ctx.verifier.address,
            milestones: [
              { amount: 40_000_000n, deadline: allocNow + 1n * HOUR },
            ],
            grace: HOUR,
            fundingMode: "Upfront",
            timeoutPolicy: "RefundToFunder",
            title: "allocated by ref",
          },
          currentTime: allocNow,
          scriptRefs,
        },
      );
      yield* signAndSubmit(allocTx);
      yield* advanceBlock(ctx.emulator);

      // Allocation is the one place a caller used to need an escrow's token
      // name from memory. This is the lookup that removes the text field.
      const escrows = yield* getPoolEscrowsProgram(ctx.lucid, {
        poolTokenName,
      });
      expect(escrows).toHaveLength(1);
      expect(escrows[0]!.title).toBe("allocated by ref");
      expect(escrows[0]!.topUpEligible).toBe(true);
      expect(escrows[0]!.totalMilestones).toBe(1);
      expect(escrows[0]!.lockedBalance > 0n).toBe(true);

      // The name it returns resolves to the escrow that was just allocated —
      // it is the value `allocateToEscrow` takes as `existingStateTokenName`.
      const state = yield* getEscrowStateProgram(ctx.lucid, {
        stateTokenName: escrows[0]!.stateTokenName,
      });
      expect(state.totalMilestones).toBe(1);
    }),
  );

  it.effect("the deprecated escrowScriptRef field still works", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;

      selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
      const { tx: poolTx, poolTokenName } = yield* unsignedCreatePoolTxProgram(
        ctx.lucid,
        { title: "legacy field pool" },
      );
      yield* signAndSubmit(poolTx);
      yield* advanceBlock(ctx.emulator);

      const depositTx = yield* unsignedDepositToPoolTxProgram(ctx.lucid, {
        poolTokenName,
        amount: 120_000_000n,
      });
      yield* signAndSubmit(depositTx);
      yield* advanceBlock(ctx.emulator);

      const allocNow = BigInt(ctx.emulator.now());
      const { tx: allocTx } = yield* unsignedAllocateToEscrowTxProgram(
        ctx.lucid,
        {
          poolTokenName,
          newEscrow: {
            beneficiaryAddress: ctx.beneficiary.address,
            verifier: ctx.verifier.address,
            milestones: [
              { amount: 40_000_000n, deadline: allocNow + 1n * HOUR },
            ],
            grace: HOUR,
            fundingMode: "Upfront",
            timeoutPolicy: "RefundToFunder",
            title: "allocated by legacy field",
          },
          currentTime: allocNow,
          escrowScriptRef: ctx.escrowRef,
        },
      );
      yield* signAndSubmit(allocTx);
      yield* advanceBlock(ctx.emulator);
    }),
  );

  it.effect(
    "falls back to the session default when no per-call refs given",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        configureEscrowV2ReferenceScripts({ escrow: ctx.escrowRef });
        const result = yield* Effect.either(
          Effect.gen(function* () {
            const stateTokenName = yield* createEscrow(ctx);
            return yield* getEscrowStateProgram(ctx.lucid, { stateTokenName });
          }),
        );
        clearEscrowV2ReferenceScripts();
        expect(result._tag).toBe("Right");
        if (result._tag === "Right")
          expect(result.right.totalMilestones).toBe(2);
      }),
  );

  it.effect("keeps the 11.4 KB script out of the transaction body", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
      const now = BigInt(ctx.emulator.now());
      const config = {
        beneficiaryAddress: ctx.beneficiary.address,
        verifier: ctx.verifier.address,
        milestones: [{ amount: 40_000_000n, deadline: now + 1n * HOUR }],
        grace: HOUR,
        fundingMode: "Upfront" as const,
        timeoutPolicy: "RefundToFunder" as const,
        title: "size probe",
        currentTime: now,
      };

      const inline = yield* unsignedCreateEscrowV2TxProgram(ctx.lucid, config);
      const byRef = yield* unsignedCreateEscrowV2TxProgram(ctx.lucid, {
        ...config,
        scriptRefs: { escrow: ctx.escrowRef },
      });

      const inlineBytes = inline.tx.toCBOR().length / 2;
      const refBytes = byRef.tx.toCBOR().length / 2;

      // The whole point of a reference script: the validator bytes stop
      // riding in the witness set. Anything less than the script's own size
      // means the ref was ignored and the script was inlined anyway.
      expect(inlineBytes - refBytes).toBeGreaterThan(11_000);
    }),
  );

  it.effect("rejects a reference UTxO carrying the wrong validator", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const err = yield* Effect.flip(
        verifyEscrowV2ScriptRefs({ escrow: ctx.poolRef }),
      );
      expect(err._tag).toBe("ReferenceScriptMismatchError");
      expect(err.validator).toBe("escrowV2");
    }),
  );

  it.effect("rejects a UTxO that carries no script reference at all", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const utxos = yield* Effect.promise(() =>
        ctx.lucid.utxosAt(ctx.funder.address),
      );
      const plain = utxos.find((u) => !u.scriptRef)!;
      const err = yield* Effect.flip(
        verifyEscrowV2ScriptRefs({ escrow: plain }),
      );
      expect(err._tag).toBe("ReferenceScriptMismatchError");
      expect(err.actualHash).toBe("none");
    }),
  );
});
