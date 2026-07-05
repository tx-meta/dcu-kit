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
  TreasuryDatum,
  TreasuryDatumSchema,
  TreasuryRedeemer,
  RecoveryAction,
} from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
import {
  getWalletAddress,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
} from "../core/utils/index.js";
import {
  DcuError,
  InvalidDatumError,
  TransactionBuildError,
} from "../core/errors.js";

/**
 * Creates an unsigned transaction vetoing (cancelling) a pending lost-member
 * RecoveryRequest (Cluster A) — the anti-theft escape proving recovery != theft.
 *
 * **Functionality:**
 * - Spends + destroys the RecoveryRequest UTxO; burns its authenticating token N'.
 * - No timelock gate — the veto is valid at ANY time, even right after ProposeRecovery.
 * - No group reference needed — the on-chain redeemer carries only `request_input_index`;
 *   authorization is found by SCANNING all spending `inputs` for either (a) the real
 *   holder of `target_token` (the lost member proving they are NOT lost), or (b) a
 *   member from the request's `approvals` set withdrawing their support. There is no
 *   dedicated authorizer index field (deliberately, to avoid index-as-auth).
 * - This endpoint builds the target-holder veto path (a): the connected wallet holds
 *   the target (N) account token and signs.
 *
 * @param lucid - Lucid instance with wallet selected (must hold the target N token).
 * @param config - CancelRecoveryConfig.
 * @returns Effect yielding a TxSignBuilder.
 */
export type CancelRecoveryConfig = {
  targetTokenSuffix: string; // N — the lost member's account token suffix
  newAccountTokenSuffix: string; // N' — the pending request's authenticating token
  scriptRefs?: ScriptRefs;
};

export const unsignedCancelRecoveryTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: CancelRecoveryConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const {
      accountPolicyId,
      treasuryValidator,
      treasuryPolicyId,
      settingsUnit,
    } = protocol;
    const { targetTokenSuffix, newAccountTokenSuffix } = config;

    const requestUnit =
      treasuryPolicyId + assetNameLabels.prefix222 + newAccountTokenSuffix;
    const targetAccountUnit =
      accountPolicyId + assetNameLabels.prefix222 + targetTokenSuffix;

    const requestUtxoRaw = yield* resolveUtxoByUnit(lucid, requestUnit);
    const targetAccountUtxoRaw = yield* resolveUtxoByUnit(
      lucid,
      targetAccountUnit,
    );
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const requestUtxo = patchInlineDatum(requestUtxoRaw);
    const targetAccountUtxo = patchInlineDatum(targetAccountUtxoRaw);

    const requestDatum = (yield* parseSafeDatum(
      requestUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("RecoveryRequest" in requestDatum)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "requestDatum",
          reason: "Expected RecoveryRequest for CancelRecovery",
        }),
      );
    }
    const { new_member_tokenname } = requestDatum.RecoveryRequest;

    const newMemberToken = toUnit(treasuryPolicyId, new_member_tokenname);
    const burnAssets: Assets = { [newMemberToken]: -1n };

    const address = yield* getWalletAddress(lucid);

    // Treasury split: field-less literals for both the spend and the burn; the
    // RECOVERY CancelAction covers the RecoveryRequest UTxO being spent.
    const cancelSpendRedeemer = Data.to("CancelRecovery", TreasuryRedeemer);
    const cancelAction: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { CancelAction: { covered_inputs: [inputIndices[0]] } },
          RecoveryAction,
        ),
      inputs: [requestUtxo],
    };

    const baseTx0 = lucid
      .newTx()
      .collectFrom([requestUtxo], cancelSpendRedeemer)
      .collectFrom([targetAccountUtxo])
      .mintAssets(burnAssets, cancelSpendRedeemer)
      // The dispatcher's spend and mint handlers read ProtocolSettings from the
      // reference inputs to resolve the recovery family's stake hash.
      .readFrom([settingsUtxo])
      // Return the target token holder's account token + its original lovelace.
      .pay.ToAddress(targetAccountUtxo.address, targetAccountUtxo.assets)
      .addSigner(address);

    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const network = lucid.config().network!;
    const withValidators = attachFamilyWithdrawal(
      scriptRefs.treasury
        ? baseTx0.readFrom([scriptRefs.treasury])
        : baseTx0.attach.SpendingValidator(treasuryValidator.spendTreasury),
      protocol,
      network,
      "recovery",
      cancelAction,
      scriptRefs,
    );

    const tx = yield* withValidators.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "cancelRecovery",
            error: String(e),
          }),
      ),
    );
    return tx;
  });
