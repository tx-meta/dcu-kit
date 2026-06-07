import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
  Assets,
  toUnit,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { effectiveScriptRefs } from "../core/scripts.js";
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
 * Creates an unsigned transaction for claiming an earmarked payout (Pull mode).
 *
 * **Functionality:**
 * - Withdraws exactly `claimable_balance` (in the contribution asset) from the member's
 *   treasury UTxO; the collateral and membership token stay locked.
 * - Resets `claimable_balance` to 0 on the treasury continuation output.
 * - Authorization is by possession of the member (222) token — a member who lost their
 *   original wallet can claim from any wallet holding the token, to any destination.
 *
 * @param lucid - Lucid instance with wallet selected (must hold the member 222 token).
 * @param config - ClaimPayoutConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ClaimPayoutConfig = {
  accountTokenSuffix: string;
  // Where the claimed funds go. Defaults to the signing wallet's address — set this to
  // claim to a fresh address (the lost-wallet recovery path).
  destinationAddress?: string;
  // Reference script UTxOs (from deploy-scripts) to keep the tx under the size limit.
  scriptRefs?: { treasury?: UTxO };
};

export const unsignedClaimPayoutTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: ClaimPayoutConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const {
      treasuryValidator,
      treasuryPolicyId,
      accountPolicyId,
      groupPolicyId,
      settingsUnit,
    } = protocol;
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const { accountTokenSuffix, destinationAddress } = config;

    const memberRefName = assetNameLabels.prefix222 + accountTokenSuffix;
    const accountUnit = accountPolicyId + memberRefName;
    const treasuryUnit = treasuryPolicyId + memberRefName;

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
          reason: "Expected TreasuryState for ClaimPayout",
        }),
      );
    }

    const ts = treasuryDatum.TreasuryState;
    const claimable = ts.claimable_balance;
    if (claimable <= 0n) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "claimable_balance",
          reason: "Nothing to claim — claimable_balance is 0",
        }),
      );
    }

    // The treasury datum links to its group's reference (100) token — resolve it read-only
    // for the contribution asset identity (the validator measures the withdrawal in it).
    const groupRefUnit = groupPolicyId + ts.group_reference_tokenname;
    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);
    const groupDatum = groupCip68.groupDatum;

    const address = yield* getWalletAddress(lucid);
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );
    const memberToken = toUnit(treasuryPolicyId, memberRefName);

    // The contribution asset may be ADA (empty policy id → "lovelace") or a native token.
    const isAdaContribution = groupDatum.contribution_fee_policyid === "";
    const contributionUnit = isAdaContribution
      ? "lovelace"
      : toUnit(
          groupDatum.contribution_fee_policyid,
          groupDatum.contribution_fee_assetname,
        );

    // Treasury continuation: same datum with claimable reset to 0; value reduced by exactly
    // the earmark in the contribution asset (collateral + membership token untouched).
    const updatedDatum: TreasuryDatum = {
      TreasuryState: { ...ts, claimable_balance: 0n },
    };
    const outputAssets: Assets = { ...treasuryUtxo.assets };
    const remaining = (outputAssets[contributionUnit] ?? 0n) - claimable;
    if (contributionUnit === "lovelace") {
      outputAssets.lovelace = remaining;
    } else if (remaining > 0n) {
      outputAssets[contributionUnit] = remaining;
    } else {
      delete outputAssets[contributionUnit];
    }
    outputAssets[memberToken] = 1n;

    // Claimed funds to the destination (default: the signing wallet). Token groups also need
    // min-UTxO ADA on the output.
    const claimedAssets: Assets = isAdaContribution
      ? { lovelace: claimable }
      : { lovelace: 2_000_000n, [contributionUnit]: claimable };

    // Group's canonical position among ALL reference inputs: group + settings, plus the
    // optional treasury ref-script when scriptRefs are used. Hardcoding 0n breaks once the
    // P5 settings UTxO (or a ref-script) sorts ahead of the group input.
    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const claimRefInputs = [groupUtxo, settingsUtxo];
    if (scriptRefs.treasury) claimRefInputs.push(scriptRefs.treasury);
    const groupRefInputIndex = referenceInputIndex(claimRefInputs, groupUtxo);

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            ClaimPayout: {
              group_ref_input_index: groupRefInputIndex,
              member_input_index: inputIndices[0],
              treasury_output_index: 0n,
            },
          },
          TreasuryRedeemer,
        ),
      inputs: [accountUtxo, treasuryUtxo],
    };

    const baseTx = lucid
      .newTx()
      .collectFrom([accountUtxo])
      .collectFrom([treasuryUtxo], redeemer)
      .readFrom([groupUtxo])
      .addSigner(address)
      .pay.ToContract(
        treasuryAddress,
        { kind: "inline", value: Data.to(updatedDatum, TreasuryDatum) },
        outputAssets,
      )
      .pay.ToAddress(destinationAddress ?? address, claimedAssets)
      // Explicitly return the account token to the member (forces coin selection to fund
      // its min-ADA from the wallet rather than failing on a thin change output).
      .pay.ToAddress(address, { [accountUnit]: 1n });

    const withValidator = scriptRefs.treasury
      ? baseTx.readFrom([scriptRefs.treasury])
      : baseTx.attach.SpendingValidator(treasuryValidator.spendTreasury);

    const tx = yield* withValidator
      .readFrom([settingsUtxo])
      .completeProgram(
        lucid.config().network === "Custom" ? { localUPLCEval: false } : {},
      )
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "claimPayout",
              error: String(e),
            }),
        ),
      );

    return tx;
  });
