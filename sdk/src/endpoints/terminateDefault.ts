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
import {
  AdminAuthConfig,
  applyAdminWitness,
  payAdminReturn,
} from "../multisig/index.js";
import { effectiveScriptRefs, ScriptRefs } from "../core/scripts.js";
import { attachFamilyWithdrawal } from "../core/familyWithdraw.js";
import {
  TreasuryDatum,
  TreasuryDatumSchema,
  TreasuryRedeemer,
  LifecycleAction,
  ReserveAction,
  GroupDatum,
  GroupSpendRedeemer,
} from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
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
  parseGroupCip68Datum,
  buildGroupCip68Datum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  removeRegistryEntry,
  reserveTokenName,
} from "../core/utils/index.js";

// --- Configuration ---

export type TerminateDefaultConfig = {
  groupTokenSuffix: string;
  // The (222) account token suffix of the defaulting member to terminate.
  memberAccountTokenSuffix: string;
  currentTime?: bigint; // POSIX ms — emulator.now() for emulator, omit for live network
  // Reference script UTxOs (from deploy-scripts). When provided, the validator
  // script bytes are resolved from the on-chain UTxO, keeping the tx under 16KB.
  scriptRefs?: ScriptRefs;
} & AdminAuthConfig;

// --- Endpoint ---

/**
 * Creates an unsigned transaction terminating a member stuck in DefaultState whose grace
 * window (including any extensions) has fully expired.
 *
 * **Functionality:**
 * - Spends the defaulter's DefaultState treasury UTxO (TerminateDefault redeemer).
 * - Burns the membership token; the forfeited contributable balance flows INTO the
 *   group's mutual reserve (ReserveCover leg — defaulter's own assets first), and the
 *   reserve's stand-in counter grows by the defaulter's remaining rounds this lap.
 *   The admin keeps only the defaulter's min-ADA lovelace as change.
 * - Spends the Group UTxO with the Exit redeemer to decrement member_count and remove the
 *   member from the registry (keeping the `length(member_token_names) == member_count`
 *   invariant intact).
 * - Time-gated on-chain: the tx lower bound must be strictly greater than the member's
 *   grace_expires_at, so termination is only possible after grace + extensions lapse.
 *
 * @param lucid - Lucid instance with the admin wallet selected (holds the group 222 token).
 * @param config - TerminateDefaultConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedTerminateDefaultTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: TerminateDefaultConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const {
      treasuryValidator,
      treasuryPolicyId,
      groupValidator,
      groupPolicyId,
      settingsUnit,
    } = protocol;
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const { groupTokenSuffix, memberAccountTokenSuffix, currentTime } = config;

    const groupRefName = assetNameLabels.prefix100 + groupTokenSuffix;
    const groupRefUnit = groupPolicyId + groupRefName;
    const adminUnit =
      groupPolicyId + assetNameLabels.prefix222 + groupTokenSuffix;

    // Group UTxO — SPENT (the Exit redeemer decrements member_count).
    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);
    const groupDatum = groupCip68.groupDatum;

    // Admin UTxO — holds the group (222) user token proving admin authority.
    const adminUtxo = yield* resolveUtxoByUnit(lucid, adminUnit);

    // Find the DefaultState treasury UTxO for this member.
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
          "DefaultState" in parsed &&
          parsed.DefaultState.member_reference_tokenname === memberRefName
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
    if (!("DefaultState" in treasuryDatum)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "treasuryDatum",
          reason: "Expected DefaultState for TerminateDefault",
        }),
      );
    }

    const memberToken = toUnit(treasuryPolicyId, memberRefName);
    const burnAssets: Assets = { [memberToken]: -1n };

    // ─── Reserve leg (ReserveCover) ───────────────────────────────────────────
    // The group's reserve UTxO receives the defaulter's forfeited contributable
    // balance, and standin_rounds grows by their remaining rounds this lap.
    const reserveUnit = treasuryPolicyId + reserveTokenName(groupRefName);
    const reserveUtxoRaw = yield* resolveUtxoByUnit(lucid, reserveUnit);
    const reserveUtxo = patchInlineDatum(reserveUtxoRaw);
    const reserveDatum = (yield* parseSafeDatum(
      reserveUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("ReserveState" in reserveDatum)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "reserveDatum",
          reason: "Expected ReserveState on the reserve UTxO",
        }),
      );
    }

    // Forfeit = the defaulter's contributable balance in the contribution asset
    // (min-ADA excluded for ADA-denominated groups — it returns to the admin).
    const feeIsAda = groupDatum.contribution_fee_policyid === "";
    const contributionUnit = feeIsAda
      ? "lovelace"
      : toUnit(
          groupDatum.contribution_fee_policyid,
          groupDatum.contribution_fee_assetname,
        );
    const defaulterRaw = treasuryUtxo.assets[contributionUnit] ?? 0n;
    const forfeit = feeIsAda ? defaulterRaw - 2_000_000n : defaulterRaw;

    // standin increment: the defaulter's remaining contribution rounds this lap.
    const remaining = groupDatum.is_started
      ? groupDatum.era_start_round +
        groupDatum.num_rounds -
        (groupDatum.last_distributed_round + 1n)
      : 0n;
    const standinIncrement = remaining > 0n ? remaining : 0n;

    const updatedReserveDatum: TreasuryDatum = {
      ReserveState: {
        ...reserveDatum.ReserveState,
        standin_rounds:
          reserveDatum.ReserveState.standin_rounds + standinIncrement,
      },
    };
    const reserveOutAssets: Assets = {
      ...reserveUtxo.assets,
      [contributionUnit]:
        (reserveUtxo.assets[contributionUnit] ?? 0n) + forfeit,
    };

    // Reserve spend — pinned to this genuine termination. Treasury split: field-less
    // spend literal; the RESERVE CoverAction covers the reserve UTxO.
    // Outputs: 0 = group, 1 = reserve (admin return follows).
    const reserveCoverRedeemer = Data.to("ReserveCover", TreasuryRedeemer);
    const coverAction: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            CoverAction: {
              covered_inputs: [inputIndices[2]], // reserve
              group_ref_input_index: inputIndices[0],
              group_output_index: 0n,
              defaulter_input_index: inputIndices[1],
              reserve_output_index: 1n,
            },
          },
          ReserveAction,
        ),
      inputs: [groupUtxo, treasuryUtxo, reserveUtxo],
    };

    // Updated Group datum: decrement member_count and drop the member from the registry.
    const remainingRegistry = removeRegistryEntry(
      groupDatum.member_token_names,
      groupDatum.member_slots,
      memberRefName,
    );
    const updatedGroupDatum: GroupDatum = {
      ...groupDatum,
      member_count: groupDatum.member_count - 1n,
      member_token_names: remainingRegistry.names,
      member_slots: remainingRegistry.slots,
    };

    // Group validator redeemer: Exit (permissionless at the group level — authorised by the
    // membership token being spent at the treasury; the treasury validator enforces the
    // admin/grace gate). Group output is index 0.
    const groupRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            Exit: {
              group_ref_token_name: groupRefName,
              member_token_name: memberRefName,
              group_input_index: inputIndices[0],
              group_output_index: 0n,
            },
          },
          GroupSpendRedeemer,
        ),
      inputs: [groupUtxo],
    };

    // Treasury split: field-less spend/burn literal; the LIFECYCLE TerminateDefaultAction
    // covers the defaulter's treasury UTxO and points at the group spending input +
    // admin input. group_output_index is 0n.
    const terminateSpendRedeemer = Data.to(
      "TerminateDefault",
      TreasuryRedeemer,
    );
    const terminateDefaultAction: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            TerminateDefaultAction: {
              covered_inputs: [inputIndices[2]], // treasury
              group_ref_input_index: inputIndices[0],
              group_output_index: 0n,
              admin_input_index: inputIndices[1],
            },
          },
          LifecycleAction,
        ),
      inputs: [groupUtxo, adminUtxo, treasuryUtxo],
    };

    const address = yield* getWalletAddress(lucid);

    // Grace gate: the validator requires get_lower_bound(tx) > grace_expires_at. Match the
    // slot-aligned validFrom used by exitGroup/distribute so the lower bound is deterministic.
    const rawNow =
      currentTime !== undefined ? currentTime : BigInt(Date.now()) - 120_000n;
    const now = currentTime !== undefined ? rawNow : rawNow - (rawNow % 1000n);

    const baseTx0 = lucid
      .newTx()
      .collectFrom([groupUtxo], groupRedeemer)
      .collectFrom([adminUtxo])
      .collectFrom([treasuryUtxo], terminateSpendRedeemer)
      .collectFrom([reserveUtxo], reserveCoverRedeemer)
      .addSigner(address)
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
        reserveUtxo.address,
        { kind: "inline", value: Data.to(updatedReserveDatum, TreasuryDatum) },
        reserveOutAssets,
      )
      .mintAssets(burnAssets, terminateSpendRedeemer)
      .validFrom(Number(now));

    const baseTx = payAdminReturn(baseTx0, config, adminUtxo);

    // Reference scripts when provided — avoids inlining ~12KB of validator bytes.
    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const network = lucid.config().network!;
    const refUtxos = [scriptRefs.treasury, scriptRefs.group].filter(
      Boolean,
    ) as UTxO[];
    let withValidators =
      refUtxos.length > 0 ? baseTx.readFrom(refUtxos) : baseTx;
    if (!scriptRefs.treasury)
      withValidators = withValidators.attach
        .MintingPolicy(treasuryValidator.mintTreasury)
        .attach.SpendingValidator(treasuryValidator.spendTreasury);
    if (!scriptRefs.group)
      withValidators = withValidators.attach.SpendingValidator(
        groupValidator.spendGroup,
      );
    // Lifecycle (TerminateDefaultAction) + reserve (CoverAction) both run once.
    withValidators = attachFamilyWithdrawal(
      withValidators,
      protocol,
      network,
      "lifecycle",
      terminateDefaultAction,
      scriptRefs,
    );
    withValidators = attachFamilyWithdrawal(
      withValidators,
      protocol,
      network,
      "reserve",
      coverAction,
      scriptRefs,
    );

    const withSigners = applyAdminWitness(withValidators, config);

    // The reserve continuation output (and, on the script path, the admin-token
    // return) forces coin selection to pull a fee input AFTER the RedeemerBuilder
    // indices were computed, which Lucid rejects ("Coin selection had to be updated
    // after building redeemers"). Pre-setting a minimum fee makes the first selection
    // pass reserve that input up front, keeping the selected-input indices stable.
    // Excess over the real fee returns as change.
    const withMinFee = withSigners.setMinFee(2_200_000n);

    const tx = yield* withMinFee
      .readFrom([settingsUtxo])
      // Plain completeProgram (like exitGroup, which also spends the group + reads settings)
      // so local UPLC evaluation runs — the emulator then genuinely enforces the grace gate,
      // admin auth, member_count decrement, and burn rather than only checking construction.
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "terminateDefault",
              error: String(e),
            }),
        ),
      );
    return tx;
  });
