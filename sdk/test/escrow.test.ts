import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  CML,
  credentialToAddress,
  Emulator,
  fromText,
  generateEmulatorAccount,
  generatePrivateKey,
  Lucid,
  LucidEvolution,
  paymentCredentialOf,
  PROTOCOL_PARAMETERS_DEFAULT,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import {
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/utils/index.js";
import { buildMultisig } from "../src/multisig/index.js";
import { unsignedCreateEscrowTxProgram } from "../src/escrow/endpoints/createEscrow.js";
import { unsignedReleaseMilestoneTxProgram } from "../src/escrow/endpoints/releaseMilestone.js";
import { unsignedReclaimEscrowTxProgram } from "../src/escrow/endpoints/reclaimEscrow.js";
import { unsignedAbortEscrowTxProgram } from "../src/escrow/endpoints/abortEscrow.js";
import { getEscrowStateProgram } from "../src/escrow/queries/getEscrowState.js";
import { advanceBlock } from "./effects.js";

// ---------------------------------------------------------------------------
// Standalone context: the escrow family needs no DCU protocol deploy —
// just an emulator with funder / beneficiary / verifier wallets.
// ---------------------------------------------------------------------------

type EscrowContext = {
  lucid: LucidEvolution;
  emulator: Emulator;
  funder: { seedPhrase: string; address: string };
  // Beneficiary and verifier are raw-key wallets so co-signed txs can chain
  // `sign.withPrivateKey` (the emulator's seed accounts expose no private key).
  beneficiary: { privateKey: string; address: string };
  verifier: { privateKey: string; address: string };
};

const rawKeyWallet = () => {
  const privateKey = generatePrivateKey();
  const hash = CML.PrivateKey.from_bech32(privateKey)
    .to_public()
    .hash()
    .to_hex();
  return {
    privateKey,
    address: credentialToAddress("Custom", { type: "Key", hash }),
  };
};

const makeEscrowContext = Effect.gen(function* () {
  const funder = generateEmulatorAccount({ lovelace: 2_000_000_000n });
  const beneficiary = rawKeyWallet();
  const verifier = rawKeyWallet();
  const emulator = new Emulator([funder], PROTOCOL_PARAMETERS_DEFAULT);
  const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));

  // Fund the raw-key wallets (the verifier pays release fees).
  selectWalletFromSeed(lucid, funder.seedPhrase);
  const fundTx = yield* Effect.promise(() =>
    lucid
      .newTx()
      .pay.ToAddress(beneficiary.address, { lovelace: 100_000_000n })
      .pay.ToAddress(verifier.address, { lovelace: 100_000_000n })
      .complete(),
  );
  yield* signAndSubmit(fundTx);
  yield* advanceBlock(emulator);

  return { lucid, emulator, funder, beneficiary, verifier };
});

const keyHash = (address: string) => paymentCredentialOf(address).hash;

/** Default 3-tranche ADA escrow: 40 + 40 + 20 ADA, expiry 1h out. */
const createDefaultEscrow = (
  ctx: EscrowContext,
  overrides?: {
    expiry?: bigint;
    verifier?: { type: "Key" | "Script"; hash: string };
  },
) =>
  Effect.gen(function* () {
    selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
    const now = BigInt(ctx.emulator.now());
    const { tx, stateTokenName } = yield* unsignedCreateEscrowTxProgram(
      ctx.lucid,
      {
        beneficiaryAddress: ctx.beneficiary.address,
        verifier:
          overrides?.verifier ??
          ({ type: "Key", hash: keyHash(ctx.verifier.address) } as const),
        milestones: [40_000_000n, 40_000_000n, 20_000_000n],
        expiry: overrides?.expiry ?? now + 3_600_000n,
        currentTime: now,
      },
    );
    yield* signAndSubmit(tx);
    yield* advanceBlock(ctx.emulator);
    return stateTokenName;
  });

/** Release as the verifier (raw-key wallet builds, signs, and pays the fee). */
const releaseAsVerifier = (ctx: EscrowContext, stateTokenName: string) =>
  Effect.gen(function* () {
    ctx.lucid.selectWallet.fromPrivateKey(ctx.verifier.privateKey);
    const tx = yield* unsignedReleaseMilestoneTxProgram(ctx.lucid, {
      stateTokenName,
      currentTime: BigInt(ctx.emulator.now()),
    });
    yield* signAndSubmit(tx);
    yield* advanceBlock(ctx.emulator);
  });

/** Wallet signature plus raw-key co-signatures, then submit. */
const coSignAndSubmit = (
  ctx: EscrowContext,
  tx: TxSignBuilder,
  privateKeys: string[],
) =>
  Effect.gen(function* () {
    const signed = yield* Effect.promise(() =>
      privateKeys
        .reduce((t, pk) => t.sign.withPrivateKey(pk), tx.sign.withWallet())
        .complete(),
    );
    const txHash = yield* Effect.promise(() => signed.submit());
    yield* advanceBlock(ctx.emulator);
    return txHash;
  });

describe("escrow lifecycle (emulator)", () => {
  it.effect("creates an escrow and reads its state", () =>
    Effect.gen(function* () {
      const ctx = yield* makeEscrowContext;
      const stateTokenName = yield* createDefaultEscrow(ctx);

      const state = yield* getEscrowStateProgram(ctx.lucid, { stateTokenName });
      expect(state.releasedCount).toBe(0);
      expect(state.totalMilestones).toBe(3);
      expect(state.nextTranche).toBe(40_000_000n);
      // ADA escrow: remaining balance includes the min-ADA buffer.
      expect(state.remainingBalance).toBe(102_000_000n);
      expect(state.expired).toBe(false);
    }),
  );

  it.effect("releases the first tranche to the beneficiary", () =>
    Effect.gen(function* () {
      const ctx = yield* makeEscrowContext;
      const stateTokenName = yield* createDefaultEscrow(ctx);

      yield* releaseAsVerifier(ctx, stateTokenName);

      const state = yield* getEscrowStateProgram(ctx.lucid, { stateTokenName });
      expect(state.releasedCount).toBe(1);
      expect(state.nextTranche).toBe(40_000_000n);
      expect(state.remainingBalance).toBe(62_000_000n);

      const beneficiaryUtxos = yield* Effect.promise(() =>
        ctx.lucid.utxosAt(ctx.beneficiary.address),
      );
      const received = beneficiaryUtxos.some(
        (u) => u.assets.lovelace === 40_000_000n,
      );
      expect(received).toBe(true);
    }),
  );

  it.effect("full lifecycle: three releases end the escrow with a burn", () =>
    Effect.gen(function* () {
      const ctx = yield* makeEscrowContext;
      const stateTokenName = yield* createDefaultEscrow(ctx);

      yield* releaseAsVerifier(ctx, stateTokenName);
      yield* releaseAsVerifier(ctx, stateTokenName);
      yield* releaseAsVerifier(ctx, stateTokenName);

      // State token burned — the escrow no longer resolves.
      const gone = yield* Effect.either(
        getEscrowStateProgram(ctx.lucid, { stateTokenName }),
      );
      expect(gone._tag).toBe("Left");
    }),
  );

  it.effect("final release returns the min-ADA buffer to the funder", () =>
    Effect.gen(function* () {
      const ctx = yield* makeEscrowContext;
      const stateTokenName = yield* createDefaultEscrow(ctx);

      yield* releaseAsVerifier(ctx, stateTokenName);
      yield* releaseAsVerifier(ctx, stateTokenName);

      const lovelaceAt = (address: string) =>
        Effect.promise(() => ctx.lucid.utxosAt(address)).pipe(
          Effect.map((utxos) =>
            utxos.reduce((sum, u) => sum + u.assets.lovelace, 0n),
          ),
        );
      const funderBefore = yield* lovelaceAt(ctx.funder.address);
      const verifierBefore = yield* lovelaceAt(ctx.verifier.address);

      yield* releaseAsVerifier(ctx, stateTokenName);

      // The escrow held final tranche + 2 ADA buffer; the buffer goes back to
      // the funder, never into the verifier's change.
      const funderAfter = yield* lovelaceAt(ctx.funder.address);
      const verifierAfter = yield* lovelaceAt(ctx.verifier.address);
      expect(funderAfter - funderBefore).toBe(2_000_000n);
      expect(verifierAfter < verifierBefore).toBe(true);
    }),
  );

  it.effect("native-token escrow: full lifecycle with a distinct verifier", () =>
    Effect.gen(function* () {
      const ctx = yield* makeEscrowContext;

      // Dummy token under a 1-of-1 native policy on the funder key.
      selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
      const mintPolicy = yield* buildMultisig(ctx.lucid, {
        signers: [keyHash(ctx.funder.address)],
        required: 1,
      });
      const unit = mintPolicy.policyHash + fromText("DUMMY");
      const mintTx = yield* Effect.promise(() =>
        ctx.lucid
          .newTx()
          .mintAssets({ [unit]: 100n })
          .attach.MintingPolicy(mintPolicy.script)
          .complete(),
      );
      yield* signAndSubmit(mintTx);
      yield* advanceBlock(ctx.emulator);

      const now = BigInt(ctx.emulator.now());
      const { tx, stateTokenName } = yield* unsignedCreateEscrowTxProgram(
        ctx.lucid,
        {
          beneficiaryAddress: ctx.beneficiary.address,
          verifier: { type: "Key", hash: keyHash(ctx.verifier.address) },
          milestones: [60n, 40n],
          assetPolicy: mintPolicy.policyHash,
          assetName: fromText("DUMMY"),
          expiry: now + 3_600_000n,
          currentTime: now,
        },
      );
      yield* signAndSubmit(tx);
      yield* advanceBlock(ctx.emulator);

      yield* releaseAsVerifier(ctx, stateTokenName);
      yield* releaseAsVerifier(ctx, stateTokenName);

      // Final release burned the state token and delivered all 100 tokens.
      const gone = yield* Effect.either(
        getEscrowStateProgram(ctx.lucid, { stateTokenName }),
      );
      expect(gone._tag).toBe("Left");
      const beneficiaryUtxos = yield* Effect.promise(() =>
        ctx.lucid.utxosAt(ctx.beneficiary.address),
      );
      const tokensReceived = beneficiaryUtxos.reduce(
        (sum, u) => sum + (u.assets[unit] ?? 0n),
        0n,
      );
      expect(tokensReceived).toBe(100n);
    }),
  );

  it.effect("funder reclaims the remainder after expiry", () =>
    Effect.gen(function* () {
      const ctx = yield* makeEscrowContext;
      const now = BigInt(ctx.emulator.now());
      const expiry = now + 300_000n; // 5 minutes
      const stateTokenName = yield* createDefaultEscrow(ctx, { expiry });

      // One tranche out before the deadline passes.
      yield* releaseAsVerifier(ctx, stateTokenName);

      // Push the emulator clock past expiry (20s per block).
      yield* advanceBlock(ctx.emulator, 20);
      expect(BigInt(ctx.emulator.now()) > expiry).toBe(true);

      selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
      const tx = yield* unsignedReclaimEscrowTxProgram(ctx.lucid, {
        stateTokenName,
        currentTime: BigInt(ctx.emulator.now()),
      });
      yield* signAndSubmit(tx);
      yield* advanceBlock(ctx.emulator);

      const gone = yield* Effect.either(
        getEscrowStateProgram(ctx.lucid, { stateTokenName }),
      );
      expect(gone._tag).toBe("Left");
    }),
  );

  it.effect("funder and beneficiary co-sign an abort", () =>
    Effect.gen(function* () {
      const ctx = yield* makeEscrowContext;
      const stateTokenName = yield* createDefaultEscrow(ctx);

      selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
      const tx = yield* unsignedAbortEscrowTxProgram(ctx.lucid, {
        stateTokenName,
        payouts: [
          { address: ctx.funder.address, assets: { lovelace: 62_000_000n } },
          {
            address: ctx.beneficiary.address,
            assets: { lovelace: 40_000_000n },
          },
        ],
      });
      yield* coSignAndSubmit(ctx, tx, [ctx.beneficiary.privateKey]);

      const gone = yield* Effect.either(
        getEscrowStateProgram(ctx.lucid, { stateTokenName }),
      );
      expect(gone._tag).toBe("Left");
    }),
  );

  it.effect(
    "multisig verifier releases via the dust-UTxO pattern (D5 end-to-end)",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeEscrowContext;
        const khVerifier = keyHash(ctx.verifier.address);
        const khFunder = keyHash(ctx.funder.address);
        const khBeneficiary = keyHash(ctx.beneficiary.address);

        selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
        const multisig = yield* buildMultisig(ctx.lucid, {
          signers: [khVerifier, khFunder, khBeneficiary],
          required: 2,
        });

        // Fund the dust UTxO that proves the script credential on release.
        const dustTx = yield* Effect.promise(() =>
          ctx.lucid
            .newTx()
            .pay.ToAddress(multisig.address, { lovelace: 2_000_000n })
            .complete(),
        );
        yield* signAndSubmit(dustTx);
        yield* advanceBlock(ctx.emulator);

        const stateTokenName = yield* createDefaultEscrow(ctx, {
          verifier: { type: "Script", hash: multisig.policyHash },
        });

        selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
        const releaseTx = yield* unsignedReleaseMilestoneTxProgram(ctx.lucid, {
          stateTokenName,
          verifierWitness: {
            script: multisig.script,
            signerKeyHashes: [khVerifier, khFunder],
          },
          currentTime: BigInt(ctx.emulator.now()),
        });
        yield* coSignAndSubmit(ctx, releaseTx, [ctx.verifier.privateKey]);

        const state = yield* getEscrowStateProgram(ctx.lucid, {
          stateTokenName,
        });
        expect(state.releasedCount).toBe(1);
        expect(state.remainingBalance).toBe(62_000_000n);
      }),
  );

  it.effect("SDK guards: no release after expiry, no reclaim before it", () =>
    Effect.gen(function* () {
      const ctx = yield* makeEscrowContext;
      const now = BigInt(ctx.emulator.now());
      const stateTokenName = yield* createDefaultEscrow(ctx, {
        expiry: now + 300_000n,
      });

      // Reclaim before expiry: rejected by the endpoint guard.
      selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
      const early = yield* Effect.either(
        unsignedReclaimEscrowTxProgram(ctx.lucid, {
          stateTokenName,
          currentTime: BigInt(ctx.emulator.now()),
        }),
      );
      expect(early._tag).toBe("Left");

      // Release after expiry: rejected by the endpoint guard.
      yield* advanceBlock(ctx.emulator, 20);
      ctx.lucid.selectWallet.fromPrivateKey(ctx.verifier.privateKey);
      const late = yield* Effect.either(
        unsignedReleaseMilestoneTxProgram(ctx.lucid, {
          stateTokenName,
          currentTime: BigInt(ctx.emulator.now()),
        }),
      );
      expect(late._tag).toBe("Left");
    }),
  );
});
