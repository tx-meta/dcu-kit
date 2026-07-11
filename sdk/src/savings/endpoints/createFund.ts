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
} from "../../core/errors.js";
import {
  getWalletAddress,
  getWalletUtxos,
  makeReturn,
  sortUtxos,
} from "../../core/utils/index.js";
import {
  PartyRef,
  partyToCredential,
  SavingsDatum,
  SavingsMintRedeemer,
} from "../types.js";
import { savingsPolicyId, savingsVaultValidator } from "../validators.js";
import {
  fundStateTokenName,
  MIN_ADA_BUFFER,
  savingsVaultAddress,
} from "../utils.js";

/**
 * Creates an unsigned transaction opening a savings fund: the anchor NFT
 * carrying the charter (share price, purchase band, withdrawal policy), the
 * quorum credential, and zeroed totals. The anchor UTxO custodies the pooled
 * fund from here on.
 *
 * @param lucid - Lucid instance with the paying wallet selected.
 * @param config - CreateFundConfig.
 * @returns Effect yielding `{ tx, fundTokenName }` — persist the name.
 */
export type CreateFundConfig = {
  /** Short human-readable label, max 64 UTF-8 bytes. Never PII. */
  title: string;
  /** The ratification authority (address or multisig). Defaults to the wallet. */
  quorum?: PartyRef;
  /** The fund's asset. Omit (or "") for ADA. */
  assetPolicy?: string;
  assetName?: string;
  /** Price of one share unit in base units of the asset. */
  shareValue: bigint;
  /** Per-transaction purchase band (defaults 1..100). */
  minSharesPerDeposit?: bigint;
  maxSharesPerDeposit?: bigint;
  /** 0 = locked until share-out (VSLA, default); 1 = flexible (ASCA). */
  withdrawalPolicy?: bigint;
  /** CloseCycle is invalid before this bound (POSIX ms). */
  cycleEnd?: bigint;
};

export const unsignedCreateFundTxProgram = (
  lucid: LucidEvolution,
  config: CreateFundConfig,
): Effect.Effect<
  { tx: TxSignBuilder; fundTokenName: string },
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
    const minShares = config.minSharesPerDeposit ?? 1n;
    const maxShares = config.maxSharesPerDeposit ?? 100n;
    const withdrawalPolicy = config.withdrawalPolicy ?? 0n;
    if (config.shareValue <= 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "shareValue",
          message: "shareValue must be positive",
        }),
      );
    }
    if (minShares <= 0n || minShares > maxShares) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "minSharesPerDeposit",
          message: "purchase band must satisfy 0 < min <= max",
        }),
      );
    }
    if (withdrawalPolicy !== 0n && withdrawalPolicy !== 1n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "withdrawalPolicy",
          message: "withdrawalPolicy must be 0 (locked) or 1 (flexible)",
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
    const fundTokenName = yield* fundStateTokenName(seed);
    const fundUnit = savingsPolicyId + fundTokenName;
    const quorum = yield* partyToCredential(
      config.quorum ?? walletAddress,
      "quorum",
    );

    const datum: SavingsDatum = {
      SavingsFund: {
        title: titleHex,
        quorum,
        asset_policy: config.assetPolicy ?? "",
        asset_name: config.assetName ?? "",
        share_value: config.shareValue,
        min_shares_per_deposit: minShares,
        max_shares_per_deposit: maxShares,
        withdrawal_policy: withdrawalPolicy,
        cycle_end: config.cycleEnd ?? null,
        shares_total: 0n,
        savings_total: 0n,
        social_total: 0n,
        status: "Active",
      },
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            CreateFund: {
              seed_input_index: inputIndices[0],
              fund_output_index: 0n,
            },
          },
          SavingsMintRedeemer,
        ),
      inputs: [seed],
    };

    const network = lucid.config().network ?? "Preprod";
    const tx = yield* lucid
      .newTx()
      .collectFrom([seed])
      .mintAssets({ [fundUnit]: 1n }, redeemer)
      .attach.MintingPolicy(savingsVaultValidator.mintVault)
      .pay.ToContract(
        savingsVaultAddress(network),
        { kind: "inline", value: Data.to(datum, SavingsDatum) },
        { lovelace: MIN_ADA_BUFFER, [fundUnit]: 1n },
      )
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "createFund",
              error: String(e),
            }),
        ),
      );

    return { tx, fundTokenName };
  });

export const createFund = (lucid: LucidEvolution, config: CreateFundConfig) =>
  makeReturn(unsignedCreateFundTxProgram(lucid, config));
