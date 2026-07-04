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
import { effectiveScriptRefs, ScriptRefs } from "../core/scripts.js";
import { attachFamilyWithdrawal } from "../core/familyWithdraw.js";
import {
  GroupSpendRedeemer,
  TreasuryDatum,
  TreasuryDatumSchema,
  TreasuryRedeemer,
  RecoveryAction,
} from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
import {
  parseGroupCip68Datum,
  buildGroupCip68Datum,
  getWalletAddress,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
} from "../core/utils/index.js";
import {
  DcuError,
  InvalidDatumError,
  UtxoNotFoundError,
  TransactionBuildError,
} from "../core/errors.js";

/**
 * Creates an unsigned transaction executing a lost-member recovery after its
 * timelock has passed (Cluster A) — rotates the lost member's identity N -> N'.
 *
 * **Functionality:**
 * - Spends the RecoveryRequest UTxO (holding N') and the lost member's treasury
 *   UTxO (holding N); burns N; relocates N' into the rotated treasury output (N'
 *   was already minted at ProposeRecovery — never re-minted here).
 * - The group is a SPENDING input here (unlike Propose/Approve where it's a
 *   reference input) — `RecoverMember` performs the registry swap N -> N' in the
 *   SAME tx. `group_ref_input_index`/`group_input_index` therefore index into
 *   `inputs`, not `reference_inputs`.
 * - The treasury `ExecuteRecovery` redeemer is carried by BOTH the request UTxO and
 *   the member treasury UTxO — the validator's self-reference check at the entry
 *   point accepts either as the triggering spend.
 * - Timelock-gated: `get_lower_bound(tx) >= earliest_execution_slot`. Uses the
 *   project's `validFrom` clock-drift buffer so the lower bound is deterministic.
 *
 * @param lucid - Lucid instance with wallet selected (any caller may execute once
 *   the timelock has passed and quorum is met — no special authority required).
 * @param config - ExecuteRecoveryConfig.
 * @returns Effect yielding a TxSignBuilder.
 */
export type ExecuteRecoveryConfig = {
  groupTokenSuffix: string;
  targetTokenSuffix: string; // N — the lost member's account token suffix
  newAccountTokenSuffix: string; // N' — the recovered member's new account token suffix
  currentTime?: bigint; // POSIX ms — emulator.now() for emulator, Date.now() for live
  scriptRefs?: ScriptRefs;
};

export const unsignedExecuteRecoveryTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: ExecuteRecoveryConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const {
      groupValidator,
      groupPolicyId,
      treasuryValidator,
      treasuryPolicyId,
      settingsUnit,
    } = protocol;
    const { groupTokenSuffix, targetTokenSuffix, newAccountTokenSuffix } =
      config;

    const groupUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    const requestUnit =
      treasuryPolicyId + assetNameLabels.prefix222 + newAccountTokenSuffix;
    const memberTreasuryUnit =
      treasuryPolicyId + assetNameLabels.prefix222 + targetTokenSuffix;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupUnit);
    const requestUtxoRaw = yield* resolveUtxoByUnit(lucid, requestUnit);
    const memberTreasuryUtxoRaw = yield* resolveUtxoByUnit(
      lucid,
      memberTreasuryUnit,
    );
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const requestUtxo = patchInlineDatum(requestUtxoRaw);
    const memberTreasuryUtxo = patchInlineDatum(memberTreasuryUtxoRaw);

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

    const requestDatum = (yield* parseSafeDatum(
      requestUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("RecoveryRequest" in requestDatum)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "requestDatum",
          reason: "Expected RecoveryRequest for ExecuteRecovery",
        }),
      );
    }
    const { target_token, new_member_tokenname, new_payment_credential } =
      requestDatum.RecoveryRequest;

    const memberDatum = (yield* parseSafeDatum(
      memberTreasuryUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("TreasuryState" in memberDatum) && !("DefaultState" in memberDatum)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "memberDatum",
          reason: "Expected TreasuryState or DefaultState for ExecuteRecovery",
        }),
      );
    }

    // Rotated datum: ONLY member_reference_tokenname -> N' and
    // member_payment_credential -> new_payment_credential change; everything else preserved.
    const rotatedDatum: TreasuryDatum =
      "TreasuryState" in memberDatum
        ? {
            TreasuryState: {
              ...memberDatum.TreasuryState,
              member_reference_tokenname: new_member_tokenname,
              member_payment_credential: new_payment_credential,
            },
          }
        : {
            DefaultState: {
              ...memberDatum.DefaultState,
              member_reference_tokenname: new_member_tokenname,
              member_payment_credential: new_payment_credential,
            },
          };

    // Registry swap IN PLACE: N' takes N's registry position, so the paired
    // member_slots entry (the member's rotation turn) is preserved.
    const updatedGroupDatum = {
      ...groupDatum,
      member_token_names: groupDatum.member_token_names.map((n) =>
        n === target_token ? new_member_tokenname : n,
      ),
    };

    const oldMemberToken = toUnit(treasuryPolicyId, target_token);
    const newMemberToken = toUnit(treasuryPolicyId, new_member_tokenname);
    const burnAssets: Assets = { [oldMemberToken]: -1n };

    // Rotated output value: same value as the member treasury input, but with N
    // removed and N' added — the rest (lovelace, contribution asset) is conserved.
    const rotatedAssets: Assets = { ...memberTreasuryUtxo.assets };
    delete rotatedAssets[oldMemberToken];
    rotatedAssets[newMemberToken] = 1n;

    const address = yield* getWalletAddress(lucid);

    const rawNow =
      config.currentTime !== undefined
        ? config.currentTime
        : BigInt(Date.now()) - 120_000n;
    const now =
      config.currentTime !== undefined ? rawNow : rawNow - (rawNow % 1000n);

    // Treasury split: field-less spend literal, carried by BOTH the request and
    // member treasury spending inputs (a plain redeemer string, so — unlike the
    // old RedeemerBuilder — it can be shared across both collectFrom calls without
    // the object-identity hazard). The RECOVERY ExecuteAction runs the heavy
    // validation once, covering BOTH spent inputs in
    // [request, member_treasury] order. Output layout: [0] group (registry swap),
    // [1] rotated member treasury.
    const executeSpendRedeemer = Data.to("ExecuteRecovery", TreasuryRedeemer);
    const executeAction: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            ExecuteAction: {
              covered_inputs: [idx[0], idx[1]], // request, member treasury
              group_ref_input_index: idx[2], // group (spending input)
              group_output_index: 0n,
              member_treasury_output_index: 1n,
            },
          },
          RecoveryAction,
        ),
      inputs: [requestUtxo, memberTreasuryUtxo, groupUtxo],
    };

    // Group RecoverMember redeemer — performs the registry swap N -> N'.
    const recoverMemberRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            RecoverMember: {
              group_ref_token_name: groupRefName,
              group_input_index: idx[0], // group
              group_output_index: 0n,
              old_member_token_name: target_token,
              new_member_token_name: new_member_tokenname,
              treasury_input_index: idx[1], // member treasury
              treasury_output_index: 1n,
            },
          },
          GroupSpendRedeemer,
        ),
      inputs: [groupUtxo, memberTreasuryUtxo],
    };

    const baseTx0 = lucid
      .newTx()
      .collectFrom([requestUtxo], executeSpendRedeemer)
      .collectFrom([memberTreasuryUtxo], executeSpendRedeemer)
      .collectFrom([groupUtxo], recoverMemberRedeemer)
      .mintAssets(burnAssets, executeSpendRedeemer)
      .pay.ToContract(
        groupUtxo.address,
        {
          kind: "inline",
          value: buildGroupCip68Datum(
            groupCip68.metadata,
            groupCip68.version,
            updatedGroupDatum,
          ),
        },
        groupUtxo.assets,
      )
      .pay.ToContract(
        memberTreasuryUtxo.address,
        { kind: "inline", value: Data.to(rotatedDatum, TreasuryDatum) },
        rotatedAssets,
      )
      .addSigner(address)
      // The dispatcher's spend and mint handlers read ProtocolSettings from the
      // reference inputs to resolve the recovery family's stake hash.
      .readFrom([settingsUtxo])
      .validFrom(Number(now));

    // None of the 3 collected inputs (request/member-treasury/group) belong to the
    // caller's wallet — the fee input is pulled entirely by coin selection AFTER the
    // RedeemerBuilders' indices are computed from the first pass, which Lucid rejects
    // ("Coin selection had to be updated after building redeemers"). Pre-setting a
    // minimum fee reserves that wallet input up front so the selected-input indices
    // stay stable (same pattern as terminateDefault.ts's script-admin path).
    const baseTx1 = baseTx0.setMinFee(2_000_000n);

    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const network = lucid.config().network!;
    const refUtxos = [scriptRefs.treasury, scriptRefs.group].filter(
      Boolean,
    ) as UTxO[];
    let withValidators =
      refUtxos.length > 0 ? baseTx1.readFrom(refUtxos) : baseTx1;
    if (!scriptRefs.treasury)
      withValidators = withValidators.attach.SpendingValidator(
        treasuryValidator.spendTreasury,
      );
    if (!scriptRefs.group)
      withValidators = withValidators.attach.SpendingValidator(
        groupValidator.spendGroup,
      );
    withValidators = attachFamilyWithdrawal(
      withValidators,
      protocol,
      network,
      "recovery",
      executeAction,
      scriptRefs,
    );

    const tx = yield* withValidators
      .completeProgram(
        lucid.config().network === "Custom" ? { localUPLCEval: false } : {},
      )
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "executeRecovery",
              error: String(e),
            }),
        ),
      );
    return tx;
  });
