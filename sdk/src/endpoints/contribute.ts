import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
  toUnit,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  TreasuryDatum,
  TreasuryDatumSchema,
  TreasuryRedeemer,
} from "../core/types.js";
import {
  treasuryValidator,
  treasuryPolicyId,
  accountPolicyId,
} from "../core/validators/constants.js";
import {
  DcuError,
  InvalidDatumError,
  TransactionBuildError,
} from "../core/errors.js";
import {
  getScriptAddress,
  getWalletAddress,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
} from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for contributing (topping up) a Treasury UTxO.
 *
 * **Functionality:**
 * - Member increases the lovelace balance of their treasury UTxO.
 * - Datum is structurally unchanged (only ADA changes).
 * - Requires the Account NFT in the wallet for authorization.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - ContributeConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ContributeConfig = {
  accountTokenSuffix: string;
  topUpAmount: bigint; // extra lovelace to add to the treasury UTxO
};

export const unsignedContributeTxProgram = (
  lucid: LucidEvolution,
  config: ContributeConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { accountTokenSuffix, topUpAmount } = config;

    const memberRefName = assetNameLabels.prefix222 + accountTokenSuffix;
    const accountUnit = accountPolicyId + memberRefName;
    const treasuryUnit = treasuryPolicyId! + memberRefName;

    const accountUtxoRaw = yield* resolveUtxoByUnit(lucid, accountUnit);
    const treasuryUtxoRaw = yield* resolveUtxoByUnit(lucid, treasuryUnit);
    const accountUtxo = patchInlineDatum(accountUtxoRaw);
    const treasuryUtxo = patchInlineDatum(treasuryUtxoRaw);

    const treasuryDatum = (yield* parseSafeDatum(
      treasuryUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("TreasuryState" in treasuryDatum)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "treasuryDatum",
          reason: "Expected TreasuryState for Contribute",
        }),
      );
    }

    const address = yield* getWalletAddress(lucid);
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );
    const memberToken = toUnit(treasuryPolicyId!, memberRefName);

    const inputLovelace = treasuryUtxo.assets.lovelace;
    const outputLovelace = inputLovelace + topUpAmount;

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            Contribute: {
              member_input_index: inputIndices[0],
              treasury_input_index: inputIndices[1],
              treasury_output_index: 0n,
            },
          },
          TreasuryRedeemer,
        ),
      inputs: [accountUtxo, treasuryUtxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([accountUtxo])
      .collectFrom([treasuryUtxo], redeemer)
      .addSigner(address)
      .pay.ToContract(
        treasuryAddress,
        { kind: "inline", value: Data.to(treasuryDatum, TreasuryDatum) },
        { lovelace: outputLovelace, [memberToken]: 1n },
      )
      .attach.SpendingValidator(treasuryValidator.spendTreasury)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "contribute",
              error: String(e),
            }),
        ),
      );

    return tx;
  });
