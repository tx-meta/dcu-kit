import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  InsufficientUtxosError,
  TransactionBuildError,
} from "../../core/errors.js";
import {
  assetNameLabels,
  createCip68TokenNames,
  getWalletAddress,
  getWalletUtxos,
  makeReturn,
  sortUtxos,
  attachTxMessage,
  type TxMessage,
} from "../../core/utils/index.js";
import { SavingsDatum, SavingsMintRedeemer } from "../types.js";
import { savingsPolicyId, savingsVaultValidator } from "../validators.js";
import {
  MIN_ADA_BUFFER,
  resolveFund,
  savingsVaultAddress,
  sortedRefIndexOf,
} from "../utils.js";

/**
 * Creates an unsigned transaction joining a savings fund: mints the member's
 * CIP-68 account pair (reference token to the vault with a zeroed account
 * datum, user token to the wallet). The fund anchor is a REFERENCE input —
 * joining never contends with deposits.
 *
 * @param lucid - Lucid instance with the joining member's wallet selected.
 * @param config - JoinFundConfig.
 * @returns Effect yielding `{ tx, memberTokenSuffix }` — persist the suffix.
 */
export type JoinFundConfig = {
  /** Deployed savings script reference — pass on live networks;
   *  the ~15.5KB validator cannot ride inline within the tx limit. */
  scriptRef?: UTxO;
  /** The fund's state-token name (from createFund). */
  fundTokenName: string;
  /** Standing-layer event-capture consent (default false). */
  consent?: boolean;
  /**
   * Clock override (POSIX ms). Pass `emulator.now()` in emulator tests, and on
   * a live network pass an older time when the chain tip is lagging: the
   * default 60s drift buffer is occasionally not enough, and the ledger then
   * rejects the transaction with `OutsideValidityIntervalUTxO` because its
   * lower bound sits a few slots ahead of the tip.
   */
  currentTime?: bigint;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

export const unsignedJoinFundTxProgram = (
  lucid: LucidEvolution,
  config: JoinFundConfig,
): Effect.Effect<
  { tx: TxSignBuilder; memberTokenSuffix: string },
  DcuError,
  never
> =>
  Effect.gen(function* () {
    const { utxo: fundUtxo, fund } = yield* resolveFund(
      lucid,
      config.fundTokenName,
    );
    if (fund.status !== "Active") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message: "the fund is sharing out — joins are closed",
        }),
      );
    }

    const walletAddress = yield* getWalletAddress(lucid);
    const utxos = sortUtxos(yield* getWalletUtxos(lucid)).filter(
      (u) => !u.scriptRef,
    );
    const seed = utxos[0];
    if (!seed) {
      return yield* Effect.fail(
        new InsufficientUtxosError({ required: 1, available: 0 }),
      );
    }
    const { refTokenName, userTokenName } = yield* createCip68TokenNames(seed);
    const memberTokenSuffix = refTokenName.slice(
      assetNameLabels.prefix100.length,
    );
    const refUnit = savingsPolicyId + refTokenName;
    const userUnit = savingsPolicyId + userTokenName;

    const network = lucid.config().network ?? "Preprod";
    const now = config.currentTime ?? BigInt(Date.now());
    // Clock-drift buffer on live networks (pattern #10); exact on emulator.
    const validFrom = Number(now - (network === "Custom" ? 0n : 60_000n));

    const datum: SavingsDatum = {
      MemberAccount: {
        fund_id: config.fundTokenName,
        share_units: 0n,
        social_paid: 0n,
        borrowed: 0n,
        consent: config.consent ?? false,
        joined_at: now,
      },
    };

    // The ledger sorts the reference-input set; with the script ref in the
    // tx the anchor's position must be computed, never assumed.
    const refInputs = config.scriptRef
      ? [fundUtxo, config.scriptRef]
      : [fundUtxo];
    const fundRefIndex = sortedRefIndexOf(fundUtxo, refInputs);
    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            MintAccount: {
              seed_input_index: inputIndices[0],
              fund_ref_index: fundRefIndex,
              ref_output_index: 0n,
              user_output_index: 1n,
            },
          },
          SavingsMintRedeemer,
        ),
      inputs: [seed],
    };

    const tx = yield* (yield* attachTxMessage(lucid.newTx(), config.message))
      .readFrom([fundUtxo])
      .collectFrom([seed])
      .mintAssets({ [refUnit]: 1n, [userUnit]: 1n }, redeemer)
      .compose(
        config.scriptRef
          ? lucid.newTx().readFrom([config.scriptRef])
          : lucid.newTx().attach.MintingPolicy(savingsVaultValidator.mintVault),
      )
      .pay.ToContract(
        savingsVaultAddress(network),
        { kind: "inline", value: Data.to(datum, SavingsDatum) },
        { lovelace: MIN_ADA_BUFFER, [refUnit]: 1n },
      )
      .pay.ToAddress(walletAddress, {
        lovelace: MIN_ADA_BUFFER,
        [userUnit]: 1n,
      })
      .validFrom(validFrom)
      .validTo(Number(now + 900_000n))
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "joinFund",
              error: String(e),
            }),
        ),
      );

    return { tx, memberTokenSuffix };
  });

export const joinFund = (lucid: LucidEvolution, config: JoinFundConfig) =>
  makeReturn(unsignedJoinFundTxProgram(lucid, config));
