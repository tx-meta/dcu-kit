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
import { Protocol } from "../core/validators/constants.js";
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
  referenceInputIndex,
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
  protocol: Protocol,
  lucid: LucidEvolution,
  config: ContributeConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { treasuryValidator, treasuryPolicyId, accountPolicyId, groupPolicyId, settingsUnit } = protocol;
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const { groupTokenSuffix, accountTokenSuffix, topUpAmount } = config;

    const memberRefName = assetNameLabels.prefix222 + accountTokenSuffix;
    const accountUnit = accountPolicyId + memberRefName;
    const treasuryUnit = treasuryPolicyId + memberRefName;
    // Group reference token (read-only) — supplies the contribution asset + fee.
    const groupRefUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;

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
    // Contribute supports two input states: a TreasuryState top-up (datum unchanged) and a
    // DefaultState (ICS) recovery (transition back to TreasuryState). A PenaltyState treasury
    // cannot receive contributions.
    if ("PenaltyState" in treasuryDatum) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "treasuryDatum",
          reason: "Cannot contribute to a PenaltyState treasury",
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
    const memberToken = toUnit(treasuryPolicyId, memberRefName);

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

    // Output datum. TreasuryState top-up keeps its datum unchanged. DefaultState (ICS)
    // recovery transitions back to TreasuryState, preserving the carried fields (slot,
    // rounds_paid, payout credential, earmark) exactly as the validator's recovery branch
    // reconstructs them — and requires the post-top-up balance to reach contribution_fee.
    const recoveredBalance = outputAssets[contributionUnit] ?? 0n;
    let outputDatum: TreasuryDatum = treasuryDatum;
    if ("DefaultState" in treasuryDatum) {
      if (recoveredBalance < groupDatum.contribution_fee) {
        return yield* Effect.fail(
          new InvalidDatumError({
            field: "topUpAmount",
            reason: `DefaultState recovery requires the treasury to reach at least contribution_fee (${groupDatum.contribution_fee}); after top-up it would be ${recoveredBalance}.`,
          }),
        );
      }
      const ds = treasuryDatum.DefaultState;
      outputDatum = {
        TreasuryState: {
          group_reference_tokenname: ds.group_reference_tokenname,
          member_reference_tokenname: ds.member_reference_tokenname,
          assigned_slot: ds.assigned_slot,
          rounds_paid: ds.rounds_paid,
          member_payment_credential: ds.member_payment_credential,
          claimable_balance: ds.claimable_balance,
        },
      };
    }

    // Reference inputs are canonically ordered (by txHash, then output index) in the
    // final transaction. Since P5 added the settings UTxO as a second reference input,
    // the group is no longer guaranteed to be at index 0 — compute its real position.
    const groupRefInputIndex = referenceInputIndex(
      [groupUtxo, settingsUtxo],
      groupUtxo,
    );

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            Contribute: {
              group_ref_input_index: groupRefInputIndex,
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
        { kind: "inline", value: Data.to(outputDatum, TreasuryDatum) },
        outputAssets,
      )
      .attach.SpendingValidator(treasuryValidator.spendTreasury)
      .readFrom([settingsUtxo])
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
