import { describe, expect, it } from "vitest";
import {
  CML,
  Emulator,
  generateEmulatorAccount,
  generatePrivateKey,
  getAddressDetails,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
} from "@lucid-evolution/lucid";
import {
  addCoSignWitness,
  completeCoSignBundle,
  createCoSignBundle,
  deserializeCoSignBundle,
  getCoSignStatus,
  serializeCoSignBundle,
  signCoSignBundle,
  validateCoSignBundle,
} from "../src/multisig/index.js";

const BUNDLE_CONTEXT = { deploymentFingerprint: "ab".repeat(32) };

const keyHash = (privateKey: string): string =>
  CML.PrivateKey.from_bech32(privateKey).to_public().hash().to_hex();

describe("portable co-sign bundles", () => {
  it("round-trips independent wallet and quorum witnesses", async () => {
    const payer = generateEmulatorAccount({ lovelace: 100_000_000n });
    const emulator = new Emulator([payer], PROTOCOL_PARAMETERS_DEFAULT);
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(payer.seedPhrase);

    const payerHash = getAddressDetails(payer.address).paymentCredential?.hash;
    if (!payerHash) throw new Error("payer has no payment key hash");
    const quorumKey = generatePrivateKey();
    const quorumHash = keyHash(quorumKey);
    const tx = await lucid
      .newTx()
      .pay.ToAddress(payer.address, { lovelace: 2_000_000n })
      .addSignerKey(quorumHash)
      .complete();

    let bundle = createCoSignBundle(
      lucid,
      tx,
      [payerHash, quorumHash],
      BUNDLE_CONTEXT,
    );
    bundle = await signCoSignBundle(lucid, bundle, BUNDLE_CONTEXT).unsafeRun();
    expect(
      await getCoSignStatus(lucid, bundle, BUNDLE_CONTEXT).unsafeRun(),
    ).toMatchObject({
      ready: false,
      signedBy: [payerHash],
      missingSigners: [quorumHash],
    });

    const quorumWitness = await lucid
      .fromTx(bundle.transactionCbor)
      .partialSign.withPrivateKey(quorumKey);
    bundle = addCoSignWitness(bundle, quorumWitness);
    expect(
      (await getCoSignStatus(lucid, bundle, BUNDLE_CONTEXT).unsafeRun()).ready,
    ).toBe(true);

    const transported = deserializeCoSignBundle(
      lucid,
      serializeCoSignBundle(bundle),
      BUNDLE_CONTEXT,
    );
    const signed = await completeCoSignBundle(
      lucid,
      transported,
      BUNDLE_CONTEXT,
    ).unsafeRun();
    await expect(signed.submit()).resolves.toMatch(/^[0-9a-f]{64}$/);
    emulator.awaitBlock(1);
    await expect(
      getCoSignStatus(lucid, transported, BUNDLE_CONTEXT).unsafeRun(),
    ).rejects.toThrow(/spent or unavailable/);
  });

  it("rejects a witness over a different transaction body", async () => {
    const payer = generateEmulatorAccount({ lovelace: 100_000_000n });
    const emulator = new Emulator([payer], PROTOCOL_PARAMETERS_DEFAULT);
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(payer.seedPhrase);
    const payerHash = getAddressDetails(payer.address).paymentCredential?.hash;
    if (!payerHash) throw new Error("payer has no payment key hash");

    const first = await lucid
      .newTx()
      .pay.ToAddress(payer.address, { lovelace: 2_000_000n })
      .complete();
    const second = await lucid
      .newTx()
      .pay.ToAddress(payer.address, { lovelace: 3_000_000n })
      .complete();
    const wrongWitness = await second.partialSign.withWallet();
    const bundle = createCoSignBundle(
      lucid,
      first,
      [payerHash],
      BUNDLE_CONTEXT,
    );

    expect(() => addCoSignWitness(bundle, wrongWitness)).toThrow(
      /does not verify against the transaction body hash/,
    );
  });

  it("rejects undeclared signers before assembly", async () => {
    const payer = generateEmulatorAccount({ lovelace: 100_000_000n });
    const emulator = new Emulator([payer], PROTOCOL_PARAMETERS_DEFAULT);
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(payer.seedPhrase);
    const payerHash = getAddressDetails(payer.address).paymentCredential?.hash;
    if (!payerHash) throw new Error("payer has no payment key hash");
    const stranger = generatePrivateKey();
    const tx = await lucid
      .newTx()
      .pay.ToAddress(payer.address, { lovelace: 2_000_000n })
      .complete();
    const bundle = createCoSignBundle(lucid, tx, [payerHash], BUNDLE_CONTEXT);
    const witness = await tx.partialSign.withPrivateKey(stranger);

    expect(() => addCoSignWitness(bundle, witness)).toThrow(
      /undeclared signer/,
    );
  });

  it("rejects changed network and deployment context", async () => {
    const payer = generateEmulatorAccount({ lovelace: 100_000_000n });
    const lucid = await Lucid(
      new Emulator([payer], PROTOCOL_PARAMETERS_DEFAULT),
      "Custom",
    );
    lucid.selectWallet.fromSeed(payer.seedPhrase);
    const payerHash = getAddressDetails(payer.address).paymentCredential?.hash;
    if (!payerHash) throw new Error("payer has no payment key hash");
    const tx = await lucid
      .newTx()
      .pay.ToAddress(payer.address, { lovelace: 2_000_000n })
      .complete();
    const bundle = createCoSignBundle(lucid, tx, [payerHash], BUNDLE_CONTEXT);

    expect(() =>
      validateCoSignBundle(
        lucid,
        { ...bundle, network: "Preprod" },
        BUNDLE_CONTEXT,
      ),
    ).toThrow(/does not match/);
    expect(() =>
      validateCoSignBundle(lucid, bundle, {
        deploymentFingerprint: "cd".repeat(32),
      }),
    ).toThrow(/different validator deployment/);
  });

  it("derives transaction-body and consumed-input signers", async () => {
    const payer = generateEmulatorAccount({ lovelace: 100_000_000n });
    const lucid = await Lucid(
      new Emulator([payer], PROTOCOL_PARAMETERS_DEFAULT),
      "Custom",
    );
    lucid.selectWallet.fromSeed(payer.seedPhrase);
    const quorumKey = generatePrivateKey();
    const quorumHash = keyHash(quorumKey);
    const tx = await lucid
      .newTx()
      .pay.ToAddress(payer.address, { lovelace: 2_000_000n })
      .addSignerKey(quorumHash)
      .complete();
    const completeBundle = createCoSignBundle(
      lucid,
      tx,
      [quorumHash],
      BUNDLE_CONTEXT,
    );
    expect(completeBundle.requiredSigners).toContain(quorumHash);

    const omittedBodySigner = {
      ...completeBundle,
      requiredSigners: [] as string[],
    };
    expect(() =>
      validateCoSignBundle(lucid, omittedBodySigner, BUNDLE_CONTEXT),
    ).toThrow(/omits transaction-body required signer/);

    await expect(
      getCoSignStatus(lucid, completeBundle, BUNDLE_CONTEXT).unsafeRun(),
    ).rejects.toThrow(/omits consumed key-input signer/);
  });

  it("rejects an expired validity interval", async () => {
    const payer = generateEmulatorAccount({ lovelace: 100_000_000n });
    const emulator = new Emulator([payer], PROTOCOL_PARAMETERS_DEFAULT);
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(payer.seedPhrase);
    const payerHash = getAddressDetails(payer.address).paymentCredential?.hash;
    if (!payerHash) throw new Error("payer has no payment key hash");
    const tx = await lucid
      .newTx()
      .pay.ToAddress(payer.address, { lovelace: 2_000_000n })
      .validTo(emulator.now() + 120_000)
      .complete();
    const bundle = createCoSignBundle(lucid, tx, [payerHash], BUNDLE_CONTEXT);
    if (bundle.validity.upperSlot === null)
      throw new Error("validTo did not produce a TTL");
    const expiredSlot = BigInt(bundle.validity.upperSlot);
    expect(() => validateCoSignBundle(lucid, bundle, BUNDLE_CONTEXT)).toThrow(
      /currentSlot is required/,
    );
    expect(() =>
      validateCoSignBundle(lucid, bundle, {
        ...BUNDLE_CONTEXT,
        currentSlot: expiredSlot,
      }),
    ).toThrow(/validity interval expired/);
  });
});
