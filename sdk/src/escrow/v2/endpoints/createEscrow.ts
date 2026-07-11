import {
  Assets,
  Data,
  fromText,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  InsufficientUtxosError,
  TransactionBuildError,
} from "../../../core/errors.js";
import {
  getWalletAddress,
  getWalletUtxos,
  makeReturn,
  sortUtxos,
} from "../../../core/utils/index.js";
import {
  EscrowDatumV2,
  EscrowV2MintRedeemer,
  PartyRef,
  partyToCredential,
  toOnchainAddress,
} from "../types.js";
import { escrowV2PolicyId, escrowV2Validator } from "../validators.js";
import {
  DEFAULT_DISPUTE_WINDOW_MS,
  DEFAULT_GRACE_MS,
  escrowStateTokenName,
  escrowV2Address,
  MIN_ADA_BUFFER,
} from "../utils.js";

/**
 * Creates an unsigned transaction opening a v2 milestone escrow.
 *
 * **Functionality:**
 * - Mints the one-shot state token (name = permanent escrow identity).
 * - `Upfront`: locks the full milestone total (+ 2 ADA buffer); `PerMilestone`:
 *   locks the buffer only — fund tranches later via `contribute`.
 * - Every party is given as a plain address (or an explicit credential for
 *   script parties); nobody ever types a hash.
 * - `timeoutPolicy` decides what happens when a milestone's cure window passes
 *   with no verifier verdict: the funder reclaims (`RefundToFunder`) or the
 *   tranche becomes releasable to the beneficiary (`ReleaseToBeneficiary`).
 * - Optional `arbiterAddress` enables the dispute path (raise/resolve).
 *
 * Guard for `ReleaseToBeneficiary` + `PerMilestone`: if the escrow is never
 * funded and the beneficiary is uncooperative, the funder's only exits are
 * Abort (co-signed) or the arbiter — prefer an arbiter in this combination.
 *
 * @param lucid - Lucid instance with the funding wallet selected.
 * @param config - CreateEscrowV2Config.
 * @returns Effect yielding `{ tx, stateTokenName }` — persist `stateTokenName`.
 */
export type CreateEscrowV2Config = {
  /** Tranche destination (full address — its stake credential is pinned). */
  beneficiaryAddress: string;
  /** Release authority: an address, or `{ type, hash }` for script callers. */
  verifier: PartyRef;
  /** Optional neutral tie-breaker; omitting disables the dispute path. */
  arbiter?: PartyRef;
  /** 1-100 milestones; amounts > 0; deadlines strictly increasing (POSIX ms). */
  milestones: { amount: bigint; deadline: bigint }[];
  /** Cure window in ms added to every deadline. Default 14 days. */
  grace?: bigint;
  /** Dispute freeze duration in ms. Default 7 days. Ignored without arbiter. */
  disputeWindow?: bigint;
  fundingMode: "Upfront" | "PerMilestone";
  timeoutPolicy: "RefundToFunder" | "ReleaseToBeneficiary";
  /** Short human-readable label, max 64 UTF-8 bytes. */
  title: string;
  /** Hex hash of the off-chain terms document (IPFS CID hash or any URL's). */
  contentHash?: string;
  /** Opaque project token name linking this escrow to a Project anchor. */
  projectId?: string;
  /** Escrowed asset policy id. Omit (or "") for ADA. */
  assetPolicy?: string;
  /** Escrowed asset name. Omit (or "") for ADA. */
  assetName?: string;
  /** Refund destination + co-authority. Defaults to the wallet address. */
  funderAddress?: string;
  /** Clock override (POSIX ms) — pass `emulator.now()` in emulator tests. */
  currentTime?: bigint;
};

export const unsignedCreateEscrowV2TxProgram = (
  lucid: LucidEvolution,
  config: CreateEscrowV2Config,
): Effect.Effect<
  { tx: TxSignBuilder; stateTokenName: string },
  DcuError,
  never
> =>
  Effect.gen(function* () {
    const { milestones } = config;
    const assetPolicy = config.assetPolicy ?? "";
    const assetName = config.assetName ?? "";
    const grace = config.grace ?? DEFAULT_GRACE_MS;
    const disputeWindow = config.disputeWindow ?? DEFAULT_DISPUTE_WINDOW_MS;

    if (milestones.length === 0 || milestones.length > 100) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "milestones",
          message: "milestones must have 1-100 entries",
        }),
      );
    }
    if (milestones.some((m) => m.amount <= 0n)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "milestones",
          message: "every milestone amount must be > 0",
        }),
      );
    }
    for (let i = 1; i < milestones.length; i++) {
      if (milestones[i]!.deadline <= milestones[i - 1]!.deadline) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "milestones",
            message: "milestone deadlines must be strictly increasing",
          }),
        );
      }
    }
    const now = config.currentTime ?? BigInt(Date.now());
    if (milestones[0]!.deadline <= now + 120_000n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "milestones",
          message:
            "the first deadline must be comfortably in the future (> now + 2 min)",
        }),
      );
    }
    if (grace < 0n || disputeWindow < 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "grace",
          message: "grace and disputeWindow must be >= 0",
        }),
      );
    }
    const titleHex = fromText(config.title);
    if (titleHex.length > 128) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "title",
          message: "title must be at most 64 UTF-8 bytes",
        }),
      );
    }

    const walletAddress = yield* getWalletAddress(lucid);
    const utxos = sortUtxos(yield* getWalletUtxos(lucid));
    const seed = utxos[0];
    if (!seed) {
      return yield* Effect.fail(
        new InsufficientUtxosError({ required: 1, available: 0 }),
      );
    }

    const stateTokenName = yield* escrowStateTokenName(seed);
    const stateUnit = escrowV2PolicyId + stateTokenName;

    const funder = yield* toOnchainAddress(
      config.funderAddress ?? walletAddress,
    );
    const beneficiary = yield* toOnchainAddress(config.beneficiaryAddress);
    const verifier = yield* partyToCredential(config.verifier, "verifier");
    const arbiter = config.arbiter
      ? yield* partyToCredential(config.arbiter, "arbiter")
      : null;

    const credKey = (c: typeof verifier) =>
      "VerificationKey" in c ? `K${c.VerificationKey[0]}` : `S${c.Script[0]}`;
    if (credKey(verifier) === credKey(beneficiary.payment_credential)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "verifier",
          message:
            "the verifier must be distinct from the beneficiary — a sole release signer must never be the payee",
        }),
      );
    }
    if (
      arbiter &&
      [
        credKey(funder.payment_credential),
        credKey(beneficiary.payment_credential),
        credKey(verifier),
      ].includes(credKey(arbiter))
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "arbiter",
          message:
            "the arbiter must be distinct from funder, beneficiary, and verifier",
        }),
      );
    }

    const datum: EscrowDatumV2 = {
      funder,
      beneficiary,
      verifier,
      arbiter,
      asset_policy: assetPolicy,
      asset_name: assetName,
      milestones: milestones.map((m) => ({
        amount: m.amount,
        deadline: m.deadline,
      })),
      grace,
      dispute_window: disputeWindow,
      released_count: 0n,
      funding_mode: config.fundingMode,
      timeout_policy: config.timeoutPolicy,
      dispute: null,
      title: titleHex,
      content_hash: config.contentHash ?? null,
      evidence: milestones.map(() => null),
      project_id: config.projectId ?? null,
    };

    const total = milestones.reduce((a, m) => a + m.amount, 0n);
    const isAda = assetPolicy === "";
    const lockedAssets: Assets =
      config.fundingMode === "PerMilestone"
        ? { lovelace: MIN_ADA_BUFFER, [stateUnit]: 1n }
        : isAda
          ? { lovelace: total + MIN_ADA_BUFFER, [stateUnit]: 1n }
          : {
              lovelace: MIN_ADA_BUFFER,
              [assetPolicy + assetName]: total,
              [stateUnit]: 1n,
            };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            CreateEscrowV2: {
              seed_input_index: inputIndices[0],
              escrow_output_index: 0n,
            },
          },
          EscrowV2MintRedeemer,
        ),
      inputs: [seed],
    };

    const network = lucid.config().network ?? "Preprod";
    // Create requires a pinned upper bound strictly below deadline[0] + grace.
    const firstCure = milestones[0]!.deadline + grace;
    const validTo = Number(
      now + 1_200_000n < firstCure ? now + 1_200_000n : firstCure - 1_000n,
    );

    const tx = yield* lucid
      .newTx()
      .collectFrom([seed])
      .mintAssets({ [stateUnit]: 1n }, redeemer)
      .attach.MintingPolicy(escrowV2Validator.mintEscrow)
      .pay.ToContract(
        escrowV2Address(network),
        { kind: "inline", value: Data.to(datum, EscrowDatumV2) },
        lockedAssets,
      )
      .validTo(validTo)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "createEscrowV2",
              error: String(e),
            }),
        ),
      );

    return { tx, stateTokenName };
  });

export const createEscrow = (
  lucid: LucidEvolution,
  config: CreateEscrowV2Config,
) => makeReturn(unsignedCreateEscrowV2TxProgram(lucid, config));
