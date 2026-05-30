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
  groupPolicyId,
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
  parseGroupCip68Datum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
} from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for contributing (topping up) a Treasury UTxO.
 *
 * **Functionality:**
 * - Member increases the contribution-asset balance of their treasury UTxO.
 * - The contribution asset may be ADA or any Cardano native token (read from the group datum).
 * - Datum is structurally unchanged (TreasuryState top-up); the group UTxO is a read-only
 *   reference input supplying the contribution asset.
 * - Requires the Account NFT in the wallet for authorization.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - ContributeConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ContributeConfig = {
  groupTokenSuffix: string;
  accountTokenSuffix: string;
  topUpAmount: bigint; // extra units of the contribution asset to add to the treasury UTxO
};

export const unsignedContributeTxProgram = (
  lucid: LucidEvolution,
  config: ContributeConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupTokenSuffix, accountTokenSuffix, topUpAmount } = config;

    const memberRefName = assetNameLabels.prefix222 + accountTokenSuffix;
    const accountUnit = accountPolicyId + memberRefName;
    const treasuryUnit = treasuryPolicyId! + memberRefName;
    // Group reference token (read-only) — supplies the contribution asset + fee.
    const groupRefUnit =
      groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;

    const accountUtxoRaw = yield* resolveUtxoByUnit(lucid, accountUnit);
    const treasuryUtxoRaw = yield* resolveUtxoByUnit(lucid, treasuryUnit);
    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const accountUtxo = patchInlineDatum(accountUtxoRaw);
    const treasuryUtxo = patchInlineDatum(treasuryUtxoRaw);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);

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

    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);
    const groupDatum = groupCip68.groupDatum;

    const address = yield* getWalletAddress(lucid);
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );
    const memberToken = toUnit(treasuryPolicyId!, memberRefName);

    // The contribution asset may be ADA (empty policy id → "lovelace") or a native token.
    const contributionUnit =
      groupDatum.contribution_fee_policyid === ""
        ? "lovelace"
        : toUnit(
            groupDatum.contribution_fee_policyid,
            groupDatum.contribution_fee_assetname,
          );

    // Preserve all existing assets, increase the contribution asset by topUpAmount.
    const outputAssets: Record<string, bigint> = { ...treasuryUtxo.assets };
    outputAssets[contributionUnit] =
      (outputAssets[contributionUnit] ?? 0n) + topUpAmount;
    // Ensure the membership token is retained (it already exists in treasuryUtxo.assets).
    outputAssets[memberToken] = 1n;

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            Contribute: {
              group_ref_input_index: 0n, // first (only) reference input
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
      .readFrom([groupUtxo])
      .addSigner(address)
      .pay.ToContract(
        treasuryAddress,
        { kind: "inline", value: Data.to(treasuryDatum, TreasuryDatum) },
        outputAssets,
      )
      .attach.SpendingValidator(treasuryValidator.spendTreasury)
      .completeProgram(
        lucid.config().network === "Custom" ? { localUPLCEval: false } : {},
      )
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
