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
  groupPolicyId,
} from "../core/validators/constants.js";
import {
  DcuError,
  InvalidDatumError,
  TransactionBuildError,
} from "../core/errors.js";
import {
  getScriptAddress,
  parseGroupCip68Datum,
  getWalletAddress,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
} from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for extending a member's grace window.
 *
 * **Functionality:**
 * - Admin grants an additional grace period to a member in DefaultState.
 * - Increments grace_extensions_used by 1 and extends grace_expires_at by grace_period_length.
 * - Rejected on-chain when grace_extensions_used has reached max_grace_extensions (2).
 * - The group UTxO is consumed as a reference input (not spent) to read grace_period_length
 *   and derive the group policy ID for admin token authorization.
 *
 * @param lucid - Lucid instance with wallet selected (admin wallet).
 * @param config - ExtendGraceWindowConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ExtendGraceWindowConfig = {
  groupTokenSuffix: string;
  memberAccountTokenSuffix: string;
};

export const unsignedExtendGraceWindowTxProgram = (
  lucid: LucidEvolution,
  config: ExtendGraceWindowConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupTokenSuffix, memberAccountTokenSuffix } = config;

    // Group reference token (read-only, not spent)
    const groupRefUnit =
      groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
    // Admin holds the group (222) user token — proves admin identity
    const adminUnit =
      groupPolicyId! + assetNameLabels.prefix222 + groupTokenSuffix;
    // Member's treasury UTxO (must be DefaultState)
    const memberRefName = assetNameLabels.prefix222 + memberAccountTokenSuffix;
    const treasuryUnit = treasuryPolicyId! + memberRefName;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const adminUtxoRaw = yield* resolveUtxoByUnit(lucid, adminUnit);
    const treasuryUtxoRaw = yield* resolveUtxoByUnit(lucid, treasuryUnit);

    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const adminUtxo = patchInlineDatum(adminUtxoRaw);
    const treasuryUtxo = patchInlineDatum(treasuryUtxoRaw);

    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);
    const groupDatum = groupCip68.groupDatum;

    const treasuryDatum = (yield* parseSafeDatum(
      treasuryUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("DefaultState" in treasuryDatum)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "treasuryDatum",
          reason: "Expected DefaultState for ExtendGraceWindow",
        }),
      );
    }

    const ics = treasuryDatum.DefaultState;

    const memberToken = toUnit(treasuryPolicyId!, memberRefName);
    const address = yield* getWalletAddress(lucid);
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );

    const updatedDatum: TreasuryDatum = {
      DefaultState: {
        ...ics,
        grace_expires_at: ics.grace_expires_at + groupDatum.grace_period_length,
        grace_extensions_used: ics.grace_extensions_used + 1n,
      },
    };

    // ExtendGraceWindow uses group_ref_input_index into reference_inputs (not spending inputs).
    // The redeemer indices are: [0] = group ref input index in reference_inputs,
    // [1] = admin spending input index in inputs, [2] = treasury spending input index in inputs.
    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            ExtendGrace: {
              group_ref_input_index: 0n, // first (only) reference input
              admin_input_index: inputIndices[0],
              treasury_input_index: inputIndices[1],
              treasury_output_index: 0n,
            },
          },
          TreasuryRedeemer,
        ),
      inputs: [adminUtxo, treasuryUtxo],
    };

    // groupValidator is not needed here — group UTxO is a read-only reference input.
    const tx = yield* lucid
      .newTx()
      .collectFrom([adminUtxo])
      .collectFrom([treasuryUtxo], redeemer)
      .readFrom([groupUtxo])
      .addSigner(address)
      .pay.ToContract(
        treasuryAddress,
        { kind: "inline", value: Data.to(updatedDatum, TreasuryDatum) },
        { lovelace: treasuryUtxo.assets.lovelace, [memberToken]: 1n },
      )
      .attach.SpendingValidator(treasuryValidator.spendTreasury)
      .completeProgram(
        lucid.config().network === "Custom" ? { localUPLCEval: false } : {},
      )
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "extendGrace",
              error: String(e),
            }),
        ),
      );

    return tx;
  });
