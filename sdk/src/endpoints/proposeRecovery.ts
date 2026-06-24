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
import { TreasuryDatum, TreasuryRedeemer } from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
import {
  getScriptAddress,
  parseGroupCip68Datum,
  getWalletAddress,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  referenceInputIndex,
} from "../core/utils/index.js";
import {
  DcuError,
  UtxoNotFoundError,
  TransactionBuildError,
} from "../core/errors.js";

/**
 * Creates an unsigned transaction proposing a lost-member recovery (Cluster A).
 *
 * **Functionality:**
 * - Mints exactly 1 new treasury-side token N' (`newAccountTokenSuffix`) and locks it
 *   in a fresh RecoveryRequest UTxO at the treasury script.
 * - The group is a REFERENCE input (read-only — the registry edit happens later, at
 *   ExecuteRecovery). `group_ref_input_index` indexes into `reference_inputs`.
 * - The recoveree (holder of the brand-new account N', created beforehand via
 *   `createAccount`) proves control by SPENDING their account-N' UTxO and signing —
 *   `recoveree_signed_for_token` scans inputs+reference_inputs, but spending is the
 *   simplest way to guarantee the PKH ends up in `extra_signatories`.
 * - Each approver presents+signs their OWN account UTxO as a SPENDING input
 *   (`collect_signed_approvals` only scans `tx.inputs`, never `reference_inputs`).
 * - `earliest_execution_slot` in the request datum is fixed by the validator as
 *   `get_lower_bound(tx) + group.recovery_timelock` — the SDK must compute the SAME
 *   value from its own `validFrom` or the on-chain equality check fails.
 *
 * @param lucid - Lucid instance with wallet selected (the recoveree's wallet pays fees
 *   and signs; approvers must additionally co-sign the built tx before submission).
 * @param config - ProposeRecoveryConfig.
 * @returns Effect yielding a TxSignBuilder.
 */
export type ProposeRecoveryConfig = {
  groupTokenSuffix: string;
  targetTokenSuffix: string; // N — the lost member's account token suffix
  newAccountTokenSuffix: string; // N' — the recoveree's freshly created account token suffix
  newPaymentCredential: string; // recoveree's payment key hash — binds future payouts
  approverTokenSuffixes: string[]; // at least 1 — quorum members vouching for this recovery
  currentTime?: bigint; // POSIX ms — emulator.now() for emulator, Date.now() for live
  scriptRefs?: {
    treasury?: UTxO;
    group?: UTxO;
  };
};

export const unsignedProposeRecoveryTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: ProposeRecoveryConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const {
      groupPolicyId,
      accountPolicyId,
      treasuryValidator,
      treasuryPolicyId,
      settingsUnit,
    } = protocol;
    const {
      groupTokenSuffix,
      targetTokenSuffix,
      newAccountTokenSuffix,
      newPaymentCredential,
      approverTokenSuffixes,
    } = config;

    const groupRefUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    const newAccountUserUnit =
      accountPolicyId + assetNameLabels.prefix222 + newAccountTokenSuffix;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const newAccountUtxoRaw = yield* resolveUtxoByUnit(
      lucid,
      newAccountUserUnit,
    );
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const newAccountUtxo = patchInlineDatum(newAccountUtxoRaw);

    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);
    const groupDatum = groupCip68.groupDatum;

    const groupRefAssetEntry = Object.keys(groupUtxo.assets).find((k) =>
      k.startsWith(groupPolicyId),
    );
    if (!groupRefAssetEntry)
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: "GroupReference (100)",
          address: groupUtxo.address,
        }),
      );
    const groupRefName = groupRefAssetEntry.slice(groupPolicyId.length);

    const targetTokenName = assetNameLabels.prefix222 + targetTokenSuffix;
    const newMemberTokenName =
      assetNameLabels.prefix222 + newAccountTokenSuffix;

    // Resolve each approver's account UTxO (must be a SPENDING input + signer).
    const approverUtxos: UTxO[] = [];
    for (const suffix of approverTokenSuffixes) {
      const unit = accountPolicyId + assetNameLabels.prefix222 + suffix;
      const utxo = yield* resolveUtxoByUnit(lucid, unit);
      approverUtxos.push(patchInlineDatum(utxo));
    }
    const approverTokenNames = approverTokenSuffixes.map(
      (suffix) => assetNameLabels.prefix222 + suffix,
    );

    const address = yield* getWalletAddress(lucid);
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );

    const rawNow =
      config.currentTime !== undefined
        ? config.currentTime
        : BigInt(Date.now()) - 120_000n;
    const now =
      config.currentTime !== undefined ? rawNow : rawNow - (rawNow % 1000n);

    // Mirrors get_lower_bound(tx): validFrom(now) becomes the tx's Finite lower bound
    // (in slots on-chain, but the emulator/Lucid validity range here is POSIX ms — the
    // validator's get_lower_bound reads whatever unit the lower bound was built with,
    // so this must track the same convention used elsewhere in the SDK for slot/time math).
    const earliestExecutionSlot = now + groupDatum.recovery_timelock;

    const requestDatum: TreasuryDatum = {
      RecoveryRequest: {
        group_reference_tokenname: groupRefName,
        target_token: targetTokenName,
        new_member_tokenname: newMemberTokenName,
        new_payment_credential: newPaymentCredential,
        earliest_execution_slot: earliestExecutionSlot,
        approvals: approverTokenNames,
      },
    };

    const newMemberToken = toUnit(treasuryPolicyId, newMemberTokenName);
    const mintingAssets: Assets = { [newMemberToken]: 1n };
    const requestAssets: Assets = {
      lovelace: 2_000_000n,
      [newMemberToken]: 1n,
    };

    const groupRefInputIndex = referenceInputIndex(
      [groupUtxo, settingsUtxo],
      groupUtxo,
    );

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            ProposeRecovery: {
              group_ref_input_index: groupRefInputIndex,
              request_output_index: 0n,
              // approver indices follow the recoveree input (index 0) in `inputs`.
              approver_input_indices: inputIndices.slice(1),
            },
          },
          TreasuryRedeemer,
        ),
      inputs: [newAccountUtxo, ...approverUtxos],
    };

    const baseTx0 = lucid
      .newTx()
      .collectFrom([newAccountUtxo])
      .collectFrom(approverUtxos)
      .mintAssets(mintingAssets, redeemer)
      .readFrom([groupUtxo])
      .pay.ToContract(
        treasuryAddress,
        { kind: "inline", value: Data.to(requestDatum, TreasuryDatum) },
        requestAssets,
      )
      // Return the recoveree's account token + its original lovelace (net-zero ADA).
      .pay.ToAddress(address, newAccountUtxo.assets)
      .addSigner(address);

    // Each approver must also sign — addSigner declares the requirement; the caller
    // gathers each approver's witness on the built tx before submission.
    const withApproverSigners = approverUtxos.reduce(
      (t, u) => t.addSigner(u.address),
      baseTx0,
    );

    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const withValidators = scriptRefs.treasury
      ? withApproverSigners.readFrom([scriptRefs.treasury])
      : withApproverSigners.attach.MintingPolicy(
          treasuryValidator.mintTreasury,
        );

    const tx = yield* withValidators
      .readFrom([settingsUtxo])
      .validFrom(Number(now))
      .completeProgram(
        lucid.config().network === "Custom" ? { localUPLCEval: false } : {},
      )
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "proposeRecovery",
              error: String(e),
            }),
        ),
      );
    return tx;
  });
