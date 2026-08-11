import {
  CML,
  getAddressDetails,
  type LucidEvolution,
  type Network,
  type TransactionWitnesses,
  type TxSignBuilder,
  type TxSigned,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { CoSignBundleError } from "../core/errors.js";
import { makeReturn } from "../core/utils/tx.js";

const KEY_HASH = /^[0-9a-f]{56}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const HEX = /^(?:[0-9a-f]{2})+$/i;

export type CoSignBundleContext = {
  /** Hash of the deployment manifest/reference-script set used to build. */
  deploymentFingerprint: string;
  /** Required when the transaction has an upper validity bound. */
  currentSlot?: bigint;
};

export type CoSignBundle = {
  kind: "dcu.co-sign";
  version: 2;
  /** Network on which the body was constructed. */
  network: Network;
  /** Immutable fingerprint of the validator deployment used by the builder. */
  deploymentFingerprint: string;
  /** Complete unsigned transaction CBOR; its body is immutable after export. */
  transactionCbor: string;
  /** Transaction-body hash signed by every witness. */
  transactionHash: string;
  /** Body validity bounds in slots, JSON-safe. */
  validity: { lowerSlot: string | null; upperSlot: string | null };
  /** Every consumed input, committed by the transaction body. */
  consumedOutRefs: string[];
  /** Body-declared and input-payment key hashes required for readiness. */
  requiredSigners: string[];
  /** Independently verifiable CIP-30 transaction witness sets. */
  witnesses: TransactionWitnesses[];
};

export type CoSignStatus = {
  transactionHash: string;
  requiredSigners: string[];
  signedBy: string[];
  missingSigners: string[];
  /** True only after network/deployment/expiry/input liveness checks. */
  ready: boolean;
};

type BodyFacts = Pick<
  CoSignBundle,
  "transactionHash" | "validity" | "consumedOutRefs"
> & { bodyRequiredSigners: string[] };

const bundleError = (
  reason: CoSignBundleError["reason"],
  message: string,
  cause?: unknown,
) => new CoSignBundleError({ reason, message, cause });

const hexBytes = (hex: string): Uint8Array => {
  if (!HEX.test(hex)) throw bundleError("InvalidBundle", "invalid hex payload");
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
};

const normalizeSigner = (signer: string): string => {
  if (!KEY_HASH.test(signer))
    throw bundleError(
      "InvalidBundle",
      `required signer must be a 28-byte key hash, got ${signer}`,
    );
  return signer.toLowerCase();
};

const normalizedFingerprint = (fingerprint: string): string => {
  if (!HASH.test(fingerprint))
    throw bundleError(
      "InvalidBundle",
      "deployment fingerprint must be a 32-byte hex hash",
    );
  return fingerprint.toLowerCase();
};

const bodyFacts = (transactionCbor: string): BodyFacts => {
  try {
    const transaction = CML.Transaction.from_cbor_hex(transactionCbor);
    const body = transaction.body();
    const inputs = body.inputs();
    const consumedOutRefs: string[] = [];
    for (let index = 0; index < inputs.len(); index += 1) {
      const input = inputs.get(index);
      consumedOutRefs.push(
        `${input.transaction_id().to_hex().toLowerCase()}#${input.index()}`,
      );
    }
    const required = body.required_signers();
    const bodyRequiredSigners: string[] = [];
    if (required) {
      for (let index = 0; index < required.len(); index += 1)
        bodyRequiredSigners.push(required.get(index).to_hex().toLowerCase());
    }
    return {
      transactionHash: CML.hash_transaction(body).to_hex().toLowerCase(),
      validity: {
        lowerSlot: body.validity_interval_start()?.toString() ?? null,
        upperSlot: body.ttl()?.toString() ?? null,
      },
      consumedOutRefs,
      bodyRequiredSigners,
    };
  } catch (cause) {
    if (cause instanceof CoSignBundleError) throw cause;
    throw bundleError("InvalidBundle", "invalid transaction CBOR", cause);
  }
};

const witnessSigners = (
  witness: TransactionWitnesses,
  transactionHash: string,
): string[] => {
  try {
    const set = CML.TransactionWitnessSet.from_cbor_hex(witness);
    const vkeys = set.vkeywitnesses();
    if (!vkeys || vkeys.len() === 0)
      throw bundleError(
        "InvalidWitness",
        "witness set contains no verification-key signature",
      );
    const hash = hexBytes(transactionHash);
    const signers: string[] = [];
    for (let index = 0; index < vkeys.len(); index += 1) {
      const item = vkeys.get(index);
      const key = item.vkey();
      if (!key.verify(hash, item.ed25519_signature()))
        throw bundleError(
          "InvalidWitness",
          "witness signature does not verify against the transaction body hash",
        );
      signers.push(key.hash().to_hex().toLowerCase());
    }
    return signers;
  } catch (cause) {
    if (cause instanceof CoSignBundleError) throw cause;
    throw bundleError("InvalidWitness", "invalid witness-set CBOR", cause);
  }
};

const rehydrate = (
  lucid: LucidEvolution,
  bundle: CoSignBundle,
): TxSignBuilder => {
  try {
    const tx = lucid.fromTx(bundle.transactionCbor);
    if (tx.toHash().toLowerCase() !== bundle.transactionHash)
      throw bundleError(
        "TransactionMismatch",
        "transaction CBOR no longer matches the bundle transaction hash",
      );
    return tx;
  } catch (cause) {
    if (cause instanceof CoSignBundleError) throw cause;
    throw bundleError("InvalidBundle", "invalid transaction CBOR", cause);
  }
};

/** Export an immutable, context-bound JSON co-signing envelope. */
export const createCoSignBundle = (
  lucid: LucidEvolution,
  tx: TxSignBuilder,
  requiredSigners: readonly string[],
  context: CoSignBundleContext,
): CoSignBundle => {
  const facts = bodyFacts(tx.toCBOR());
  const normalized = Array.from(
    new Set([
      ...requiredSigners.map(normalizeSigner),
      ...facts.bodyRequiredSigners,
    ]),
  ).sort();
  if (normalized.length === 0)
    throw bundleError(
      "InvalidBundle",
      "at least one required signer must be declared or present in the body",
    );
  const network = lucid.config().network;
  if (!network)
    throw bundleError("InvalidBundle", "Lucid network is not configured");
  return {
    kind: "dcu.co-sign",
    version: 2,
    network,
    deploymentFingerprint: normalizedFingerprint(context.deploymentFingerprint),
    transactionCbor: tx.toCBOR(),
    transactionHash: facts.transactionHash,
    validity: facts.validity,
    consumedOutRefs: facts.consumedOutRefs,
    requiredSigners: normalized,
    witnesses: [],
  };
};

/** Structural/context validation; live-input validation is asynchronous. */
export const validateCoSignBundle = (
  lucid: LucidEvolution,
  value: unknown,
  context: CoSignBundleContext,
): CoSignBundle => {
  if (!value || typeof value !== "object")
    throw bundleError("InvalidBundle", "bundle must be an object");
  const candidate = value as Partial<CoSignBundle>;
  if (
    candidate.kind !== "dcu.co-sign" ||
    candidate.version !== 2 ||
    typeof candidate.network !== "string" ||
    typeof candidate.deploymentFingerprint !== "string" ||
    typeof candidate.transactionCbor !== "string" ||
    typeof candidate.transactionHash !== "string" ||
    !candidate.validity ||
    !Array.isArray(candidate.consumedOutRefs) ||
    !Array.isArray(candidate.requiredSigners) ||
    !Array.isArray(candidate.witnesses)
  )
    throw bundleError("InvalidBundle", "unsupported or incomplete bundle");

  const activeNetwork = lucid.config().network;
  if (candidate.network !== activeNetwork)
    throw bundleError(
      "NetworkMismatch",
      `bundle network ${candidate.network} does not match ${activeNetwork}`,
    );
  const expectedFingerprint = normalizedFingerprint(
    context.deploymentFingerprint,
  );
  if (
    normalizedFingerprint(candidate.deploymentFingerprint) !==
    expectedFingerprint
  )
    throw bundleError(
      "DeploymentMismatch",
      "bundle was built against a different validator deployment",
    );

  const facts = bodyFacts(candidate.transactionCbor);
  if (
    candidate.transactionHash.toLowerCase() !== facts.transactionHash ||
    candidate.validity.lowerSlot !== facts.validity.lowerSlot ||
    candidate.validity.upperSlot !== facts.validity.upperSlot ||
    JSON.stringify(candidate.consumedOutRefs) !==
      JSON.stringify(facts.consumedOutRefs)
  )
    throw bundleError(
      "TransactionMismatch",
      "transaction body facts do not match the bundle envelope",
    );

  const requiredSigners = Array.from(
    new Set(candidate.requiredSigners.map(normalizeSigner)),
  ).sort();
  const omittedBodySigner = facts.bodyRequiredSigners.find(
    (signer) => !requiredSigners.includes(signer),
  );
  if (omittedBodySigner)
    throw bundleError(
      "InvalidBundle",
      `bundle omits transaction-body required signer ${omittedBodySigner}`,
    );

  const currentSlot = context.currentSlot;
  if (facts.validity.upperSlot !== null && currentSlot === undefined)
    throw bundleError(
      "InvalidBundle",
      "currentSlot is required for a transaction with an upper validity bound",
    );
  if (
    facts.validity.upperSlot !== null &&
    currentSlot !== undefined &&
    currentSlot >= BigInt(facts.validity.upperSlot)
  )
    throw bundleError("ExpiredBundle", "transaction validity interval expired");

  const bundle: CoSignBundle = {
    kind: "dcu.co-sign",
    version: 2,
    network: candidate.network,
    deploymentFingerprint: expectedFingerprint,
    transactionCbor: candidate.transactionCbor,
    transactionHash: facts.transactionHash,
    validity: facts.validity,
    consumedOutRefs: facts.consumedOutRefs,
    requiredSigners,
    witnesses: candidate.witnesses.map((witness) => {
      if (typeof witness !== "string")
        throw bundleError("InvalidBundle", "witness must be CBOR hex");
      return witness;
    }),
  };
  rehydrate(lucid, bundle);
  bundle.witnesses.forEach((witness) => {
    const unexpected = witnessSigners(witness, bundle.transactionHash).filter(
      (signer) => !bundle.requiredSigners.includes(signer),
    );
    if (unexpected.length > 0)
      throw bundleError(
        "UnexpectedSigner",
        `witness includes undeclared signer(s): ${unexpected.join(", ")}`,
      );
  });
  return bundle;
};

/**
 * Confirms every input is still unspent and derives key-input signers from the
 * live UTxOs, preventing transport metadata from understating readiness.
 */
export const validateCoSignBundleFreshProgram = (
  lucid: LucidEvolution,
  value: unknown,
  context: CoSignBundleContext,
): Effect.Effect<CoSignBundle, CoSignBundleError> =>
  Effect.gen(function* () {
    const bundle = yield* Effect.try({
      try: () => validateCoSignBundle(lucid, value, context),
      catch: (cause) =>
        cause instanceof CoSignBundleError
          ? cause
          : bundleError("InvalidBundle", "bundle validation failed", cause),
    });
    const refs = bundle.consumedOutRefs.map((outRef) => {
      const [txHash, outputIndex] = outRef.split("#");
      return { txHash: txHash!, outputIndex: Number(outputIndex) };
    });
    const live = yield* Effect.tryPromise({
      try: () => lucid.utxosByOutRef(refs),
      catch: (cause) =>
        bundleError("StaleInputs", "failed to verify consumed inputs", cause),
    });
    const liveRefs = new Set(
      live.map((utxo) => `${utxo.txHash}#${utxo.outputIndex}`),
    );
    const stale = bundle.consumedOutRefs.filter((ref) => !liveRefs.has(ref));
    if (stale.length > 0)
      return yield* Effect.fail(
        bundleError(
          "StaleInputs",
          `bundle input(s) are spent or unavailable: ${stale.join(", ")}`,
        ),
      );
    const inputKeySigners = live.flatMap((utxo) => {
      const credential = getAddressDetails(utxo.address).paymentCredential;
      return credential?.type === "Key" ? [credential.hash.toLowerCase()] : [];
    });
    const omittedInputSigner = inputKeySigners.find(
      (signer) => !bundle.requiredSigners.includes(signer),
    );
    if (omittedInputSigner)
      return yield* Effect.fail(
        bundleError(
          "InvalidBundle",
          `bundle omits consumed key-input signer ${omittedInputSigner}`,
        ),
      );
    return bundle;
  });

export const validateCoSignBundleFresh = (
  lucid: LucidEvolution,
  value: unknown,
  context: CoSignBundleContext,
) => makeReturn(validateCoSignBundleFreshProgram(lucid, value, context));

/** Add a partial witness after checking its signature against the body hash. */
export const addCoSignWitness = (
  bundle: CoSignBundle,
  witness: TransactionWitnesses,
): CoSignBundle => {
  const signers = witnessSigners(witness, bundle.transactionHash);
  const unexpected = signers.filter(
    (signer) => !bundle.requiredSigners.includes(signer),
  );
  if (unexpected.length > 0)
    throw bundleError(
      "UnexpectedSigner",
      `witness includes undeclared signer(s): ${unexpected.join(", ")}`,
    );
  const canonical =
    CML.TransactionWitnessSet.from_cbor_hex(witness).to_canonical_cbor_hex();
  return {
    ...bundle,
    witnesses: Array.from(new Set([...bundle.witnesses, canonical])),
  };
};

const statusOf = (bundle: CoSignBundle): CoSignStatus => {
  const signedBy = Array.from(
    new Set(
      bundle.witnesses.flatMap((witness) =>
        witnessSigners(witness, bundle.transactionHash),
      ),
    ),
  ).sort();
  const missingSigners = bundle.requiredSigners.filter(
    (signer) => !signedBy.includes(signer),
  );
  return {
    transactionHash: bundle.transactionHash,
    requiredSigners: [...bundle.requiredSigners],
    signedBy,
    missingSigners,
    ready: missingSigners.length === 0,
  };
};

/** Readiness is reported only after current network/deployment/input checks. */
export const getCoSignStatusProgram = (
  lucid: LucidEvolution,
  bundle: CoSignBundle,
  context: CoSignBundleContext,
): Effect.Effect<CoSignStatus, CoSignBundleError> =>
  Effect.map(
    validateCoSignBundleFreshProgram(lucid, bundle, context),
    statusOf,
  );

export const getCoSignStatus = (
  lucid: LucidEvolution,
  bundle: CoSignBundle,
  context: CoSignBundleContext,
) => makeReturn(getCoSignStatusProgram(lucid, bundle, context));

export const signCoSignBundleProgram = (
  lucid: LucidEvolution,
  bundle: CoSignBundle,
  context: CoSignBundleContext,
): Effect.Effect<CoSignBundle, CoSignBundleError> =>
  Effect.gen(function* () {
    const validated = yield* validateCoSignBundleFreshProgram(
      lucid,
      bundle,
      context,
    );
    const witness = yield* Effect.tryPromise({
      try: () => rehydrate(lucid, validated).partialSign.withWallet(),
      catch: (cause) =>
        bundleError("InvalidWitness", "wallet partial signing failed", cause),
    });
    return yield* Effect.try({
      try: () => addCoSignWitness(validated, witness),
      catch: (cause) =>
        cause instanceof CoSignBundleError
          ? cause
          : bundleError("InvalidWitness", "cannot add wallet witness", cause),
    });
  });

export const signCoSignBundle = (
  lucid: LucidEvolution,
  bundle: CoSignBundle,
  context: CoSignBundleContext,
) => makeReturn(signCoSignBundleProgram(lucid, bundle, context));

export const completeCoSignBundleProgram = (
  lucid: LucidEvolution,
  bundle: CoSignBundle,
  context: CoSignBundleContext,
): Effect.Effect<TxSigned, CoSignBundleError> =>
  Effect.gen(function* () {
    const validated = yield* validateCoSignBundleFreshProgram(
      lucid,
      bundle,
      context,
    );
    const status = statusOf(validated);
    if (!status.ready)
      return yield* Effect.fail(
        bundleError(
          "MissingSigners",
          `missing required signer(s): ${status.missingSigners.join(", ")}`,
        ),
      );
    return yield* rehydrate(lucid, validated)
      .assemble(validated.witnesses)
      .completeProgram()
      .pipe(
        Effect.mapError((cause) =>
          bundleError(
            "InvalidWitness",
            "assembled transaction is invalid",
            cause,
          ),
        ),
      );
  });

export const completeCoSignBundle = (
  lucid: LucidEvolution,
  bundle: CoSignBundle,
  context: CoSignBundleContext,
) => makeReturn(completeCoSignBundleProgram(lucid, bundle, context));

export const serializeCoSignBundle = (bundle: CoSignBundle): string =>
  JSON.stringify(bundle);

export const deserializeCoSignBundle = (
  lucid: LucidEvolution,
  serialized: string,
  context: CoSignBundleContext,
): CoSignBundle => {
  try {
    return validateCoSignBundle(lucid, JSON.parse(serialized), context);
  } catch (cause) {
    if (cause instanceof CoSignBundleError) throw cause;
    throw bundleError("InvalidBundle", "bundle is not valid JSON", cause);
  }
};
