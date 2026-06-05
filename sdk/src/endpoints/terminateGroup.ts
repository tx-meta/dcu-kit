import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
  Assets,
  toUnit,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  TreasuryDatum,
  TreasuryDatumSchema,
  TreasuryRedeemer,
} from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
import {
  DcuError,
  InvalidDatumError,
  TransactionBuildError,
  UtxoNotFoundError,
} from "../core/errors.js";
import {
  getScriptAddress,
  getWalletAddress,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  referenceInputIndex,
} from "../core/utils/index.js";

// --- Configuration ---

export type TerminateGroupConfig = {
  groupTokenSuffix: string;
  memberAccountTokenSuffix: string;
};

// --- Endpoint ---

/**
 * Creates an unsigned transaction for claiming a PenaltyState UTxO (penalty withdrawal).
 *
 * **Functionality:**
 * - Admin withdraws a PenaltyState Treasury UTxO after a member's early exit.
 * - Burns the membership token and releases the locked ADA to the admin.
 * - The group UTxO is a read-only reference input — not spent — used only to
 *   derive the group policy ID for admin token authorisation. Same pattern as
 *   ExtendGrace. The group validator does not run.
 *
 * @param lucid - Lucid instance with wallet selected (admin wallet).
 * @param config - TerminateGroupConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedTerminateGroupTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: TerminateGroupConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { treasuryValidator, treasuryPolicyId, groupPolicyId, settingsUnit } =
      protocol;
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const { groupTokenSuffix, memberAccountTokenSuffix } = config;

    const groupRefUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    const adminUnit =
      groupPolicyId + assetNameLabels.prefix222 + groupTokenSuffix;

    // Group UTxO — reference input only, not spent
    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);

    const adminUtxo = yield* resolveUtxoByUnit(lucid, adminUnit);

    // Find the PenaltyState treasury UTxO for this member
    const memberRefName = assetNameLabels.prefix222 + memberAccountTokenSuffix;
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );
    const allTreasury = yield* Effect.tryPromise({
      try: () => lucid.utxosAt(treasuryAddress),
      catch: (e) =>
        new TransactionBuildError({
          operation: "queryTreasury",
          error: String(e),
        }),
    });

    const treasuryUtxoRaw = yield* Effect.gen(function* () {
      for (const u of allTreasury) {
        const parsed = yield* parseSafeDatum(u.datum, TreasuryDatumSchema).pipe(
          Effect.map((d) => d as unknown as TreasuryDatum),
          Effect.orElse(() => Effect.succeed(null)),
        );
        if (
          parsed &&
          "PenaltyState" in parsed &&
          parsed.PenaltyState.member_reference_tokenname === memberRefName
        ) {
          return u;
        }
      }
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: memberRefName,
          address: treasuryAddress,
        }),
      );
    });
    const treasuryUtxo = patchInlineDatum(treasuryUtxoRaw);

    const treasuryDatum = (yield* parseSafeDatum(
      treasuryUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("PenaltyState" in treasuryDatum)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "treasuryDatum",
          reason: "Expected PenaltyState for ClaimPenalty",
        }),
      );
    }

    const memberToken = toUnit(treasuryPolicyId, memberRefName);
    const burnAssets: Assets = { [memberToken]: -1n };

    // Group's canonical position among the reference inputs (group + settings) — see note
    // in contribute/claimPayout: hardcoding 0n breaks now that settings is also referenced.
    const groupRefInputIndex = referenceInputIndex(
      [groupUtxo, settingsUtxo],
      groupUtxo,
    );

    const treasurySpendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            ClaimPenalty: {
              group_ref_input_index: groupRefInputIndex,
              admin_input_index: inputIndices[0],
            },
          },
          TreasuryRedeemer,
        ),
      inputs: [adminUtxo],
    };

    // Mint redeemer — validate_claim_penalty_mint ignores redeemer fields
    const mintBurnRedeemer = Data.to(
      { ClaimPenalty: { group_ref_input_index: 0n, admin_input_index: 0n } },
      TreasuryRedeemer,
    );

    const address = yield* getWalletAddress(lucid);

    const tx = yield* lucid
      .newTx()
      .collectFrom([adminUtxo])
      .collectFrom([treasuryUtxo], treasurySpendRedeemer)
      .readFrom([groupUtxo])
      .mintAssets(burnAssets, mintBurnRedeemer)
      .addSigner(address)
      .attach.MintingPolicy(treasuryValidator.mintTreasury)
      .attach.SpendingValidator(treasuryValidator.spendTreasury)
      .readFrom([settingsUtxo])
      .completeProgram(
        lucid.config().network === "Custom" ? { localUPLCEval: false } : {},
      )
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "claimPenalty",
              error: String(e),
            }),
        ),
      );
    return tx;
  });
