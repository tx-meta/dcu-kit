import {
  Assets,
  Data,
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
} from "../../core/errors.js";
import {
  getWalletAddress,
  getWalletUtxos,
  makeReturn,
  sortUtxos,
} from "../../core/utils/index.js";
import { EscrowDatum, EscrowMintRedeemer, toOnchainAddress } from "../types.js";
import { escrowPolicyId, escrowValidator } from "../validators.js";
import { escrowAddress, escrowStateTokenName } from "../utils.js";

/**
 * Creates an unsigned transaction that locks funds in a new milestone escrow.
 *
 * **Functionality:**
 * - Mints the one-shot state token (name derived from the seed UTxO) and locks it
 *   with the full milestone total at the escrow script address.
 * - The verifier releases tranches sequentially; after `expiry` the funder reclaims
 *   the remainder; funder + beneficiary can co-sign an abort at any time.
 * - The wallet pays and is the default funder (refund destination).
 *
 * @param lucid - Lucid instance with the funding wallet selected.
 * @param config - CreateEscrowConfig.
 * @returns Effect yielding `{ tx, stateTokenName }` — persist `stateTokenName`;
 *          it is the escrow's permanent identity.
 */
export type CreateEscrowConfig = {
  /** Tranche destination (full address — its stake credential is pinned). */
  beneficiaryAddress: string;
  /** Release authority: a wallet key hash or a script hash (e.g. native multisig). */
  verifier: { type: "Key" | "Script"; hash: string };
  /** Tranche amounts in the asset's smallest unit. 1–100 entries, each > 0. */
  milestones: bigint[];
  /** POSIX ms. Releases stop at expiry; the funder can reclaim strictly after. */
  expiry: bigint;
  /** Escrowed asset policy id. Omit (or "") for ADA. */
  assetPolicy?: string;
  /** Escrowed asset name. Omit (or "") for ADA. */
  assetName?: string;
  /** Refund destination + abort co-authority. Defaults to the wallet address. */
  funderAddress?: string;
  /** Clock override (POSIX ms) — pass `emulator.now()` in emulator tests. */
  currentTime?: bigint;
};

const MIN_ADA_BUFFER = 2_000_000n;

export const unsignedCreateEscrowTxProgram = (
  lucid: LucidEvolution,
  config: CreateEscrowConfig,
): Effect.Effect<
  { tx: TxSignBuilder; stateTokenName: string },
  DcuError,
  never
> =>
  Effect.gen(function* () {
    const { milestones, expiry } = config;
    const assetPolicy = config.assetPolicy ?? "";
    const assetName = config.assetName ?? "";

    if (milestones.length === 0 || milestones.length > 100) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "milestones",
          message: "milestones must have 1-100 entries",
        }),
      );
    }
    if (milestones.some((m) => m <= 0n)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "milestones",
          message: "every milestone must be > 0",
        }),
      );
    }
    const now = config.currentTime ?? BigInt(Date.now());
    if (expiry <= now + 120_000n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "expiry",
          message: "expiry must be comfortably in the future (> now + 2 min)",
        }),
      );
    }

    const walletAddress = yield* getWalletAddress(lucid);
    // Reference-script UTxOs are never seeds — spending one as the one-shot
    // seed input destroys the deployed script for every future transaction.
    const utxos = sortUtxos(yield* getWalletUtxos(lucid)).filter(
      (u) => !u.scriptRef,
    );
    const seed = utxos[0];
    if (!seed) {
      return yield* Effect.fail(
        new InsufficientUtxosError({ required: 1, available: 0 }),
      );
    }

    const stateTokenName = yield* escrowStateTokenName(seed);
    const stateUnit = escrowPolicyId + stateTokenName;

    const funder = yield* toOnchainAddress(
      config.funderAddress ?? walletAddress,
    );
    const beneficiary = yield* toOnchainAddress(config.beneficiaryAddress);
    const verifier =
      config.verifier.type === "Key"
        ? { VerificationKey: [config.verifier.hash] as [string] }
        : { Script: [config.verifier.hash] as [string] };

    const datum: EscrowDatum = {
      funder,
      beneficiary,
      verifier,
      asset_policy: assetPolicy,
      asset_name: assetName,
      milestones,
      released_count: 0n,
      expiry,
    };

    const total = milestones.reduce((a, m) => a + m, 0n);
    const isAda = assetPolicy === "";
    const lockedAssets: Assets = isAda
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
            CreateEscrow: {
              seed_input_index: inputIndices[0],
              escrow_output_index: 0n,
            },
          },
          EscrowMintRedeemer,
        ),
      inputs: [seed],
    };

    const network = lucid.config().network ?? "Preprod";
    // Create requires a pinned upper bound strictly below expiry.
    const validTo = Number(
      now + 1_200_000n < expiry ? now + 1_200_000n : expiry - 1n,
    );

    const tx = yield* lucid
      .newTx()
      .collectFrom([seed])
      .mintAssets({ [stateUnit]: 1n }, redeemer)
      .attach.MintingPolicy(escrowValidator.mintEscrow)
      .pay.ToContract(
        escrowAddress(network),
        { kind: "inline", value: Data.to(datum, EscrowDatum) },
        lockedAssets,
      )
      .validTo(validTo)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "createEscrow",
              error: String(e),
            }),
        ),
      );

    return { tx, stateTokenName };
  });

export const createEscrow = (
  lucid: LucidEvolution,
  config: CreateEscrowConfig,
) => makeReturn(unsignedCreateEscrowTxProgram(lucid, config));
