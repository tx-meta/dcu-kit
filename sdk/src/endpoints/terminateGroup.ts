import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
  Assets,
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
  getScriptAddress,
  getWalletAddress,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  resolveTreasuryUtxoForGroup,
  attachTxMessage,
  type TxMessage,
} from "../core/utils/index.js";

// --- Configuration ---

export type TerminateGroupConfig = {
  groupTokenSuffix: string;
  memberAccountTokenSuffix: string;
  /** Deployed treasury reference script — the treasury no longer fits inline. */
  scriptRefs?: ScriptRefs;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — group-level
   * context only, never PII.
   */
  message?: TxMessage;
} & AdminAuthConfig;

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

    const groupRefName = assetNameLabels.prefix100 + groupTokenSuffix;
    const groupRefUnit = groupPolicyId + groupRefName;
    const adminUnit =
      groupPolicyId + assetNameLabels.prefix222 + groupTokenSuffix;

    // Group UTxO — reference input only, not spent
    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);

    const adminUtxo = yield* resolveUtxoByUnit(lucid, adminUnit);

    // The member's treasury UTxO IN THIS GROUP. The treasury token name is the account
    // (222) token name, so matching on it alone would return whichever group came first.
    const memberRefName = assetNameLabels.prefix222 + memberAccountTokenSuffix;
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );
    const treasuryUtxoRaw = yield* resolveTreasuryUtxoForGroup(
      lucid,
      treasuryAddress,
      treasuryPolicyId + memberRefName,
      groupRefName,
    );
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

    // Treasury split: field-less spend/burn literal; the LIFECYCLE ClaimPenaltyAction
    // covers the PenaltyState treasury UTxO being spent. (The trusted group policy
    // comes from settings, so no group_ref_input_index is needed.)
    const claimPenaltyRedeemer = Data.to("ClaimPenalty", TreasuryRedeemer);
    const claimPenaltyAction: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            ClaimPenaltyAction: {
              covered_inputs: [inputIndices[1]], // treasury
              admin_input_index: inputIndices[0],
            },
          },
          LifecycleAction,
        ),
      inputs: [adminUtxo, treasuryUtxo],
    };

    const address = yield* getWalletAddress(lucid);

    const baseTx0 = (yield* attachTxMessage(lucid.newTx(), config.message))
      .collectFrom([adminUtxo])
      .collectFrom([treasuryUtxo], claimPenaltyRedeemer)
      .readFrom([groupUtxo])
      .mintAssets(burnAssets, claimPenaltyRedeemer)
      .addSigner(address)
      .readFrom([settingsUtxo]);

    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const network = lucid.config().network!;
    const withValidator = attachFamilyWithdrawal(
      scriptRefs.treasury
        ? baseTx0.readFrom([scriptRefs.treasury])
        : baseTx0.attach
            .MintingPolicy(treasuryValidator.mintTreasury)
            .attach.SpendingValidator(treasuryValidator.spendTreasury),
      protocol,
      network,
      "lifecycle",
      claimPenaltyAction,
      scriptRefs,
    );

    const withSigners = applyAdminWitness(
      payAdminReturn(withValidator, config, adminUtxo),
      config,
    );

    const tx = yield* withSigners.completeProgram().pipe(
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
