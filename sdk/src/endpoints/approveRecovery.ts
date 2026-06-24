import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
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
  getScriptAddress,
  getWalletAddress,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  referenceInputIndex,
} from "../core/utils/index.js";
import {
  DcuError,
  InvalidDatumError,
  TransactionBuildError,
} from "../core/errors.js";

/**
 * Creates an unsigned transaction adding one more signed approval to a pending
 * lost-member RecoveryRequest (Cluster A).
 *
 * **Functionality:**
 * - Spends the RecoveryRequest UTxO and re-creates it with `approvals` extended by
 *   exactly one entry — the new approver's account token name.
 * - The group is a REFERENCE input (read-only — ApproveRecovery never edits the
 *   registry); `group_ref_input_index` indexes into `reference_inputs`.
 * - The approver presents+signs their OWN account UTxO as a SPENDING input
 *   (`signed_account_token_name` only scans `tx.inputs`).
 * - The on-chain check requires the new approver be a registry member, not already
 *   in `approvals`, and not the target (no self-vouch) — callers should pick an
 *   approver distinct from any prior proposer/approver and from the lost member.
 *
 * @param lucid - Lucid instance with wallet selected (the approver's wallet).
 * @param config - ApproveRecoveryConfig.
 * @returns Effect yielding a TxSignBuilder.
 */
export type ApproveRecoveryConfig = {
  groupTokenSuffix: string;
  targetTokenSuffix: string; // N — only used to resolve the RecoveryRequest UTxO via its N' below
  newAccountTokenSuffix: string; // N' — the pending request's authenticating token
  approverTokenSuffix: string;
  scriptRefs?: {
    treasury?: UTxO;
    group?: UTxO;
  };
};

export const unsignedApproveRecoveryTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: ApproveRecoveryConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const {
      groupPolicyId,
      accountPolicyId,
      treasuryValidator,
      treasuryPolicyId,
      settingsUnit,
    } = protocol;
    const { groupTokenSuffix, newAccountTokenSuffix, approverTokenSuffix } =
      config;

    const groupRefUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    const requestUnit =
      treasuryPolicyId + assetNameLabels.prefix222 + newAccountTokenSuffix;
    const approverUnit =
      accountPolicyId + assetNameLabels.prefix222 + approverTokenSuffix;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const requestUtxoRaw = yield* resolveUtxoByUnit(lucid, requestUnit);
    const approverUtxoRaw = yield* resolveUtxoByUnit(lucid, approverUnit);
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);

    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const requestUtxo = patchInlineDatum(requestUtxoRaw);
    const approverUtxo = patchInlineDatum(approverUtxoRaw);

    const requestDatum = (yield* parseSafeDatum(
      requestUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("RecoveryRequest" in requestDatum)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "requestDatum",
          reason: "Expected RecoveryRequest for ApproveRecovery",
        }),
      );
    }
    const existing = requestDatum.RecoveryRequest;

    const approverTokenName = assetNameLabels.prefix222 + approverTokenSuffix;

    const updatedDatum: TreasuryDatum = {
      RecoveryRequest: {
        ...existing,
        approvals: [...existing.approvals, approverTokenName],
      },
    };

    const address = yield* getWalletAddress(lucid);
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );

    const groupRefInputIndex = referenceInputIndex(
      [groupUtxo, settingsUtxo],
      groupUtxo,
    );

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            ApproveRecovery: {
              group_ref_input_index: groupRefInputIndex,
              request_input_index: inputIndices[0],
              request_output_index: 0n,
              approver_input_index: inputIndices[1],
            },
          },
          TreasuryRedeemer,
        ),
      inputs: [requestUtxo, approverUtxo],
    };

    const baseTx0 = lucid
      .newTx()
      .collectFrom([requestUtxo], redeemer)
      .collectFrom([approverUtxo])
      .readFrom([groupUtxo])
      .pay.ToContract(
        treasuryAddress,
        { kind: "inline", value: Data.to(updatedDatum, TreasuryDatum) },
        requestUtxo.assets,
      )
      // Return the approver's account token + its original lovelace (net-zero ADA).
      .pay.ToAddress(approverUtxo.address, approverUtxo.assets)
      .addSigner(address)
      .addSigner(approverUtxo.address);

    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const withValidators = scriptRefs.treasury
      ? baseTx0.readFrom([scriptRefs.treasury])
      : baseTx0.attach.SpendingValidator(treasuryValidator.spendTreasury);

    const tx = yield* withValidators
      .readFrom([settingsUtxo])
      .completeProgram(
        lucid.config().network === "Custom" ? { localUPLCEval: false } : {},
      )
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "approveRecovery",
              error: String(e),
            }),
        ),
      );
    return tx;
  });
