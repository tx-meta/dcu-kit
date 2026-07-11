import {
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
  PartyRef,
  partyToCredential,
  PoolMintRedeemer,
  VaultDatum,
} from "../types.js";
import {
  escrowV2PolicyId,
  poolPolicyId,
  poolVaultValidator,
} from "../validators.js";
import { escrowStateTokenName, poolVaultAddress } from "../utils.js";

/**
 * Creates an unsigned transaction opening a pooled commitment vault: the
 * anchor NFT carrying the pool's charter, its quorum (the ratification
 * authority — a multisig today, a vote script later, by rotation), and the
 * enforced allocation destination. Deposits are individually owned; the
 * quorum can only move them INTO milestone escrows at `escrowTarget`.
 *
 * @param lucid - Lucid instance with the paying wallet selected.
 * @param config - CreatePoolConfig.
 * @returns Effect yielding `{ tx, poolTokenName }` — persist the name.
 */
export type CreatePoolConfig = {
  /** Short human-readable label, max 64 UTF-8 bytes. */
  title: string;
  /** Hex hash of the pool's charter/mandate document. */
  contentHash?: string;
  /** The allocation authority (address or multisig). Defaults to the wallet. */
  quorum?: PartyRef;
  /** Script hash allocations must land at. Defaults to escrow v2. */
  escrowTarget?: string;
  /** The pool's asset. Omit (or "") for ADA. */
  assetPolicy?: string;
  assetName?: string;
  /** Allocations close after this (POSIX ms); exits never close. */
  fundingDeadline?: bigint;
};

export const unsignedCreatePoolTxProgram = (
  lucid: LucidEvolution,
  config: CreatePoolConfig,
): Effect.Effect<
  { tx: TxSignBuilder; poolTokenName: string },
  DcuError,
  never
> =>
  Effect.gen(function* () {
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
    const poolTokenName = yield* escrowStateTokenName(seed);
    const poolUnit = poolPolicyId + poolTokenName;
    const quorum = yield* partyToCredential(
      config.quorum ?? walletAddress,
      "quorum",
    );

    const datum: VaultDatum = {
      PoolAnchor: {
        pool: {
          title: titleHex,
          content_hash: config.contentHash ?? null,
          quorum,
          escrow_target: config.escrowTarget ?? escrowV2PolicyId,
          asset_policy: config.assetPolicy ?? "",
          asset_name: config.assetName ?? "",
          funding_deadline: config.fundingDeadline ?? null,
          status: 0n,
        },
      },
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            CreatePool: {
              seed_input_index: inputIndices[0],
              pool_output_index: 0n,
            },
          },
          PoolMintRedeemer,
        ),
      inputs: [seed],
    };

    const network = lucid.config().network ?? "Preprod";
    const tx = yield* lucid
      .newTx()
      .collectFrom([seed])
      .mintAssets({ [poolUnit]: 1n }, redeemer)
      .attach.MintingPolicy(poolVaultValidator.mintPool)
      .pay.ToContract(
        poolVaultAddress(network),
        { kind: "inline", value: Data.to(datum, VaultDatum) },
        { lovelace: 2_000_000n, [poolUnit]: 1n },
      )
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "createPool",
              error: String(e),
            }),
        ),
      );

    return { tx, poolTokenName };
  });

export const createPool = (lucid: LucidEvolution, config: CreatePoolConfig) =>
  makeReturn(unsignedCreatePoolTxProgram(lucid, config));
