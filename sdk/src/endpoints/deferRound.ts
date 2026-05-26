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
 * Creates an unsigned transaction for deferring the member's scheduled payout round.
 *
 * **Functionality:**
 * - Sets `is_deferred = true` on the member's treasury UTxO.
 * - Defers the member's scheduled round so the next slot is paid instead.
 * - The flag is reset to false by `distributeRound` after the deferred round is processed.
 * - Requires the Account NFT in the wallet for authorization.
 * - Guard: rejects if `is_deferred` is already `true` (idempotent protection).
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - DeferRoundConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type DeferRoundConfig = {
  accountTokenSuffix: string;
};

export const unsignedDeferRoundTxProgram = (
  lucid: LucidEvolution,
  config: DeferRoundConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { accountTokenSuffix } = config;

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
          reason: "Expected TreasuryState for DeferRound",
        }),
      );
    }

    const ts = treasuryDatum.TreasuryState;

    if (ts.is_deferred) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "is_deferred",
          reason: "Round is already deferred — idempotent guard",
        }),
      );
    }

    const address = yield* getWalletAddress(lucid);
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );
    const memberToken = toUnit(treasuryPolicyId!, memberRefName);

    // round_number must equal rounds_paid (deferring the next un-processed round)
    const roundNumber = ts.rounds_paid;

    const updatedDatum: TreasuryDatum = {
      TreasuryState: { ...ts, is_deferred: true },
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            DeferRound: {
              round_number: roundNumber,
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
        { kind: "inline", value: Data.to(updatedDatum, TreasuryDatum) },
        { lovelace: treasuryUtxo.assets.lovelace, [memberToken]: 1n },
      )
      .attach.SpendingValidator(treasuryValidator.spendTreasury)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "deferRound",
              error: String(e),
            }),
        ),
      );

    return tx;
  });
