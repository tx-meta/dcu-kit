import {
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
  assetNameLabels,
  createCip68TokenNames,
  getWalletAddress,
  getWalletUtxos,
  makeReturn,
  sortUtxos,
} from "../../core/utils/index.js";
import { SavingsDatum, SavingsMintRedeemer } from "../types.js";
import { savingsPolicyId, savingsVaultValidator } from "../validators.js";
import { MIN_ADA_BUFFER, resolveFund, savingsVaultAddress } from "../utils.js";

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
  /** The fund's state-token name (from createFund). */
  fundTokenName: string;
  /** Standing-layer event-capture consent (default false). */
  consent?: boolean;
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
    const now = BigInt(Date.now());
    // Clock-drift buffer on live networks (pattern #10); exact on emulator.
    const validFrom = Number(now - (network === "Custom" ? 0n : 60_000n));

    const datum: SavingsDatum = {
      MemberAccount: {
        fund_id: config.fundTokenName,
        share_units: 0n,
        social_paid: 0n,
        consent: config.consent ?? false,
        joined_at: now,
      },
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            MintAccount: {
              seed_input_index: inputIndices[0],
              // A single reference input: sorted-set index 0. If this tx ever
              // gains more reference inputs, compute the sorted position.
              fund_ref_index: 0n,
              ref_output_index: 0n,
              user_output_index: 1n,
            },
          },
          SavingsMintRedeemer,
        ),
      inputs: [seed],
    };

    const tx = yield* lucid
      .newTx()
      .readFrom([fundUtxo])
      .collectFrom([seed])
      .mintAssets({ [refUnit]: 1n, [userUnit]: 1n }, redeemer)
      .attach.MintingPolicy(savingsVaultValidator.mintVault)
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
