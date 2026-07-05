import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
  toUnit,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { effectiveScriptRefs, ScriptRefs } from "../core/scripts.js";
import { attachFamilyWithdrawal } from "../core/familyWithdraw.js";
import {
  AdminAuthConfig,
  applyAdminWitness,
  payAdminReturn,
} from "../multisig/index.js";
import {
  TreasuryDatum,
  TreasuryDatumSchema,
  TreasuryRedeemer,
  LifecycleAction,
} from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
import {
  DcuError,
  InvalidDatumError,
  TransactionBuildError,
} from "../core/errors.js";
import {
  parseGroupCip68Datum,
  getWalletAddress,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  referenceInputIndex,
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
  /** Deployed treasury reference script — the treasury no longer fits inline. */
  scriptRefs?: ScriptRefs;
} & AdminAuthConfig;

export const unsignedExtendGraceWindowTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: ExtendGraceWindowConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { treasuryValidator, treasuryPolicyId, groupPolicyId, settingsUnit } =
      protocol;
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const { groupTokenSuffix, memberAccountTokenSuffix } = config;

    // Group reference token (read-only, not spent)
    const groupRefUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    // Admin holds the group (222) user token — proves admin identity
    const adminUnit =
      groupPolicyId + assetNameLabels.prefix222 + groupTokenSuffix;
    // Member's treasury UTxO (must be DefaultState)
    const memberRefName = assetNameLabels.prefix222 + memberAccountTokenSuffix;
    const treasuryUnit = treasuryPolicyId + memberRefName;

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

    const memberToken = toUnit(treasuryPolicyId, memberRefName);
    const address = yield* getWalletAddress(lucid);

    const updatedDatum: TreasuryDatum = {
      DefaultState: {
        ...ics,
        grace_expires_at: ics.grace_expires_at + groupDatum.grace_period_length,
        grace_extensions_used: ics.grace_extensions_used + 1n,
      },
    };

    // ExtendGraceWindow uses group_ref_input_index into reference_inputs (not spending inputs).
    // Compute the group's position over the COMPLETE reference set (settings + any
    // deployed ref scripts read from: treasury dispatcher + LIFECYCLE stake validator).
    const graceRefs = effectiveScriptRefs(config.scriptRefs);
    const graceRefInputs = [groupUtxo, settingsUtxo];
    if (graceRefs.treasury) graceRefInputs.push(graceRefs.treasury);
    if (graceRefs.treasuryLifecycle)
      graceRefInputs.push(graceRefs.treasuryLifecycle);
    const groupRefInputIndex = referenceInputIndex(graceRefInputs, groupUtxo);

    // Treasury split: field-less spend literal; the LIFECYCLE ExtendGraceAction
    // covers the treasury UTxO. Group is a reference input.
    const extendGraceAction: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            ExtendGraceAction: {
              covered_inputs: [inputIndices[1]],
              group_ref_input_index: groupRefInputIndex,
              admin_input_index: inputIndices[0],
              treasury_output_index: 0n,
            },
          },
          LifecycleAction,
        ),
      inputs: [adminUtxo, treasuryUtxo],
    };

    // groupValidator is not needed here — group UTxO is a read-only reference input.
    const baseTx0 = lucid
      .newTx()
      .collectFrom([adminUtxo])
      .collectFrom([treasuryUtxo], Data.to("ExtendGrace", TreasuryRedeemer))
      .readFrom([groupUtxo])
      .addSigner(address)
      .pay.ToContract(
        treasuryUtxo.address,
        { kind: "inline", value: Data.to(updatedDatum, TreasuryDatum) },
        { lovelace: treasuryUtxo.assets.lovelace, [memberToken]: 1n },
      )
      .readFrom([settingsUtxo]);

    const network = lucid.config().network!;
    const withValidator = attachFamilyWithdrawal(
      graceRefs.treasury
        ? baseTx0.readFrom([graceRefs.treasury])
        : baseTx0.attach.SpendingValidator(treasuryValidator.spendTreasury),
      protocol,
      network,
      "lifecycle",
      extendGraceAction,
      graceRefs,
    );

    const withSigners = applyAdminWitness(
      payAdminReturn(withValidator, config, adminUtxo),
      config,
    );

    const tx = yield* withSigners
      .completeProgram()
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
