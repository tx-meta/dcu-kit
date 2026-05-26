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
  GroupDatum,
  GroupSpendRedeemer,
  TreasuryDatum,
  TreasuryDatumSchema,
  TreasuryRedeemer,
} from "../core/types.js";
import {
  treasuryValidator,
  treasuryPolicyId,
  groupValidator,
  groupPolicyId,
} from "../core/validators/constants.js";
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
} from "../core/utils/index.js";

// --- Configuration ---

export type TerminateGroupConfig = {
  groupTokenSuffix: string;
  memberAccountTokenSuffix: string; // suffix of the account whose PenaltyState UTxO to claim
};

// --- Endpoint ---

/**
 * Creates an unsigned transaction for terminating a Group membership (penalty withdrawal).
 *
 * **Functionality:**
 * - Admin withdraws a PenaltyState Treasury UTxO after member early exit.
 * - Burns the membership token and releases locked ADA to the admin.
 * - Requires the group UTxO as a spending input (to derive group policy for admin auth).
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - TerminateGroupConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedTerminateGroupTxProgram = (
  lucid: LucidEvolution,
  config: TerminateGroupConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupTokenSuffix, memberAccountTokenSuffix } = config;

    const groupRefUnit =
      groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
    const adminUnit =
      groupPolicyId! + assetNameLabels.prefix222 + groupTokenSuffix;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const adminUtxo = yield* resolveUtxoByUnit(lucid, adminUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);

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
          reason: "Expected PenaltyState for TerminateGroup",
        }),
      );
    }

    const groupDatum = yield* parseSafeDatum(groupUtxo.datum, GroupDatum);

    const groupRefAssetEntry = Object.keys(groupUtxo.assets).find((k) =>
      k.startsWith(groupPolicyId!),
    );
    if (!groupRefAssetEntry)
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: "GroupReference (100)",
          address: groupUtxo.address,
        }),
      );
    const groupRefName = groupRefAssetEntry.slice(groupPolicyId!.length);

    const memberToken = toUnit(treasuryPolicyId!, memberRefName);
    const burnAssets: Assets = { [memberToken]: -1n };
    const groupAssets: Assets = { ...groupUtxo.assets };

    // Group validator redeemer: UpdateGroup — admin spends group UTxO and returns it unchanged.
    // This is required because the treasury validator reads the group input from tx.inputs
    // (spending inputs) to derive the group policy ID for admin token verification.
    const groupRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            UpdateGroup: {
              group_ref_token_name: groupRefName,
              admin_input_index: inputIndices[1],
              group_input_index: inputIndices[0],
              group_output_index: 0n,
            },
          },
          GroupSpendRedeemer,
        ),
      inputs: [groupUtxo, adminUtxo],
    };

    // Treasury validator spend redeemer: TerminateGroup
    const treasurySpendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            TerminateGroup: {
              group_input_index: inputIndices[0],
              admin_input_index: inputIndices[1],
            },
          },
          TreasuryRedeemer,
        ),
      inputs: [groupUtxo, adminUtxo],
    };

    // The mint handler (TerminateGroup branch) calls validate_terminate_group which
    // ignores all redeemer fields. Use a plain redeemer to avoid sharing a
    // RedeemerBuilder between spend and mint contexts.
    const mintBurnRedeemer = Data.to(
      { TerminateGroup: { group_input_index: 0n, admin_input_index: 0n } },
      TreasuryRedeemer,
    );

    const address = yield* getWalletAddress(lucid);
    const groupAddress = yield* getScriptAddress(
      lucid,
      groupValidator.spendGroup,
    );

    const tx = yield* lucid
      .newTx()
      .collectFrom([groupUtxo], groupRedeemer)
      .collectFrom([adminUtxo])
      .collectFrom([treasuryUtxo], treasurySpendRedeemer)
      .mintAssets(burnAssets, mintBurnRedeemer)
      .addSigner(address)
      .pay.ToContract(
        groupAddress,
        { kind: "inline", value: Data.to(groupDatum, GroupDatum) },
        groupAssets,
      )
      .attach.MintingPolicy(treasuryValidator.mintTreasury)
      .attach.SpendingValidator(treasuryValidator.spendTreasury)
      .attach.SpendingValidator(groupValidator.spendGroup)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "terminateGroup",
              error: String(e),
            }),
        ),
      );
    return tx;
  });
