import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
  Assets,
  UTxO,
  toUnit,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { effectiveScriptRefs } from "../core/scripts.js";
import {
  GroupDatum,
  GroupSpendRedeemer,
  TreasuryDatum,
  TreasuryDatumSchema,
  TreasuryRedeemer,
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
  parseGroupCip68Datum,
  buildGroupCip68Datum,
  getWalletAddress,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  MIN_ADA_RESERVE,
} from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for exiting a Group.
 *
 * **Functionality:**
 * - Spends the Group UTxO to decrement the member count.
 * - Handles both early and mature exits from a Group.
 * - Early Exit: Transition to Penalty State (fee deduction).
 * - Mature Exit: Burn Membership token and receive full refund.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Exit Group Configuration.
 * @returns Effect yielding TxSignBuilder.
 *
 * @example
 * ```typescript
 * const program = unsignedExitGroupTxProgram(lucid,
 *   { groupUtxo, accountUtxo, treasuryUtxo }
 * );
 * ```
 */
export type ExitGroupConfig = {
  groupTokenSuffix: string;
  // Optional: the (222) account token suffix used when joining this group.
  // If omitted, the endpoint auto-detects by scanning all (222) account tokens
  // in the wallet against treasury UTxOs — handles the case where a wallet holds
  // multiple account tokens from different sessions.
  accountTokenSuffix?: string;
  currentTime?: bigint; // POSIX ms — emulator.now() for emulator, omit for live network
  // Reference script UTxOs (from deploy-scripts). When provided, the validator
  // script bytes are resolved from the on-chain UTxO, keeping the tx under 16KB.
  scriptRefs?: {
    treasury?: UTxO;
    group?: UTxO;
  };
};

export const unsignedExitGroupTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: ExitGroupConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const {
      treasuryValidator,
      treasuryPolicyId,
      groupValidator,
      groupPolicyId,
      accountPolicyId,
      settingsUnit,
    } = protocol;
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const { groupTokenSuffix, currentTime } = config;

    const groupRefUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);

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

    // Build the set of candidate member_reference_tokennames to match against.
    // If the caller provides an explicit suffix, use that single candidate.
    // Otherwise scan ALL (222) account tokens in the wallet — this handles the common
    // case where a wallet holds multiple account tokens from different sessions and the
    // "first" token found is not the one used to join this group.
    const candidateRefNames: Set<string> = yield* config.accountTokenSuffix
      ? Effect.succeed(
          new Set([assetNameLabels.prefix222 + config.accountTokenSuffix]),
        )
      : Effect.tryPromise({
          try: () => lucid.wallet().getUtxos(),
          catch: (e) =>
            new TransactionBuildError({
              operation: "getWalletUtxos",
              error: String(e),
            }),
        }).pipe(
          Effect.map(
            (walletUtxos) =>
              new Set(
                walletUtxos
                  .flatMap((u) => Object.keys(u.assets))
                  .filter((k) =>
                    k.startsWith(accountPolicyId + assetNameLabels.prefix222),
                  )
                  .map((k) => k.slice(accountPolicyId.length)), // keep prefix222 + suffix
              ),
          ),
        );

    // Find the treasury UTxO whose member_reference_tokenname is in our candidate set.
    // Use an inner Effect.gen so `return yield* Effect.fail(...)` reliably aborts the scan
    // (mutable let + for..of + yield* in the outer generator has subtle propagation issues).
    const { treasuryUtxoRaw, memberRefName } = yield* Effect.gen(function* () {
      for (const u of allTreasury) {
        const parsed = yield* parseSafeDatum(u.datum, TreasuryDatumSchema).pipe(
          Effect.map((d) => d as unknown as TreasuryDatum),
          Effect.orElse(() => Effect.succeed(null)),
        );
        if (
          parsed &&
          "TreasuryState" in parsed &&
          candidateRefNames.has(parsed.TreasuryState.member_reference_tokenname)
        ) {
          return {
            treasuryUtxoRaw: u,
            memberRefName: parsed.TreasuryState
              .member_reference_tokenname as string,
          };
        }
      }
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: [...candidateRefNames].join(" | "),
          address: treasuryAddress,
        }),
      );
    });

    const accountUserUnit = accountPolicyId + memberRefName;
    const accountUtxoRaw = yield* resolveUtxoByUnit(lucid, accountUserUnit);
    const accountUtxo = patchInlineDatum(accountUtxoRaw);
    const treasuryUtxo = patchInlineDatum(treasuryUtxoRaw);
    const treasuryDatum = (yield* parseSafeDatum(
      treasuryUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("TreasuryState" in treasuryDatum))
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "treasuryDatum",
          reason: "Expected TreasuryState",
        }),
      );

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

    const memberToken = toUnit(treasuryPolicyId, memberRefName);
    // ADA-penalty groups: the PenaltyState UTxO must hold penalty_fee of *contributable*
    // lovelace on top of the min-ADA reserve that carries the membership token, matching
    // the validator's `contributable_in(...) >= penalty_fee` floor. (Token-penalty groups
    // would additionally carry penalty_fee of the token; that path is not yet exercised.)
    const penaltyAssets: Assets = {
      lovelace: MIN_ADA_RESERVE + groupDatum.penalty_fee,
      [memberToken]: 1n,
    };
    const burnAssets: Assets = { [memberToken]: -1n };

    // Use a single `now` for isEarlyExit AND validFrom — Aiken computes is_early_exit
    // using get_lower_bound(tx), so the two must agree at the maturity boundary.
    // Three-path exit model (must mirror treasury.ak validate_exit_group):
    //   pre_cycle  (now < start_time)                  → free exit, token burned
    //   in_cycle   (active && past start && pre-mature) → penalty exit, PenaltyState
    //   post_cycle (past maturity || inactive)          → free exit, token burned
    //
    // Emulator: use currentTime directly (already slot-aligned to emulator.now()).
    // Live network: subtract 120s for clock drift, truncate to 1000ms slot boundary.
    const rawNow =
      currentTime !== undefined ? currentTime : BigInt(Date.now()) - 120_000n;
    const now = currentTime !== undefined ? rawNow : rawNow - (rawNow % 1000n);
    // [D4] Continuous model: free vs penalty is rounds_paid-anchored, not wall-clock. Free exit
    // (burn) when inactive, pre-start, or a whole cycle completed (rounds_paid > 0 &&
    // rounds_paid % num_rounds == 0); penalty (PenaltyState) when mid-cycle. The is_started
    // guard short-circuits before the modulo so pre-start (num_rounds == 0) never divides by 0.
    const roundsPaid = treasuryDatum.TreasuryState.rounds_paid;
    const completedFullCycle =
      groupDatum.is_started &&
      roundsPaid > 0n &&
      roundsPaid % groupDatum.num_rounds === 0n;
    const isEarlyExit =
      groupDatum.is_active && groupDatum.is_started && !completedFullCycle;

    // Updated Group datum: decrement member count and remove member from registry.
    const updatedGroupDatum: GroupDatum = {
      ...groupDatum,
      member_count: groupDatum.member_count - 1n,
      // ExitGroup is TreasuryState-only → the leaver was active, so the active set shrinks by 1.
      active_member_count: groupDatum.active_member_count - 1n,
      member_token_names: groupDatum.member_token_names.filter(
        (n) => n !== memberRefName,
      ),
    };

    // Group validator redeemer: MemberExit (no admin required)
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

    // Treasury validator spend redeemer: ExitGroup
    // Output layout: [0] Group UTxO, [1] Penalty (early exit only)
    const treasurySpendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            ExitGroup: {
              group_ref_input_index: inputIndices[0],
              group_output_index: 0n,
              member_input_index: inputIndices[1],
              treasury_input_index: inputIndices[2],
              penalty_output_index: isEarlyExit ? 1n : 0n,
            },
          },
          TreasuryRedeemer,
        ),
      inputs: [groupUtxo, accountUtxo, treasuryUtxo],
    };

    // Mint redeemer for mature exit burn — the mint handler (ExitGroup branch) calls
    // validate_terminate_group which ignores all index fields; any valid ExitGroup
    // redeemer works here. Using a plain Data value avoids sharing a RedeemerBuilder
    // between spend and mint contexts, which can cause index resolution issues in Lucid.
    const mintBurnRedeemer = Data.to(
      {
        ExitGroup: {
          group_ref_input_index: 0n,
          group_output_index: 0n,
          member_input_index: 0n,
          treasury_input_index: 0n,
          penalty_output_index: 0n,
        },
      },
      TreasuryRedeemer,
    );

    const address = yield* getWalletAddress(lucid);

    const penaltyDatum: TreasuryDatum = {
      PenaltyState: {
        group_reference_tokenname:
          treasuryDatum.TreasuryState.group_reference_tokenname,
        member_reference_tokenname:
          treasuryDatum.TreasuryState.member_reference_tokenname,
      },
    };

    const baseTx = lucid
      .newTx()
      .collectFrom([groupUtxo], groupRedeemer)
      .collectFrom([accountUtxo])
      .collectFrom([treasuryUtxo], treasurySpendRedeemer)
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
      );

    // Group output is index 0; the penalty output (early exit) must stay at index 1 to
    // match penalty_output_index in the redeemer. The account-token return is therefore
    // appended AFTER the penalty/burn so it never shifts those indices.
    const withPenaltyOrBurn = isEarlyExit
      ? baseTx.pay.ToContract(
          treasuryUtxo.address,
          { kind: "inline", value: Data.to(penaltyDatum, TreasuryDatum) },
          penaltyAssets,
        )
      : baseTx.mintAssets(burnAssets, mintBurnRedeemer);

    // Explicitly return the member's account (222) token to their wallet. Without this the
    // token dangles into the change output, and when the spent treasury already covers the
    // penalty/burn outputs (e.g. under the larger min-ADA-reserve deposits) coin selection
    // won't pull an extra wallet UTxO — leaving too little ADA to satisfy the token's
    // min-UTxO ("not enough ADA leftover for non-ADA change"). The explicit output forces
    // selection to fund it. Mirrors the value-neutral endpoints' pattern.
    const afterPath = withPenaltyOrBurn.pay
      .ToAddress(address, { [accountUserUnit]: 1n })
      .validFrom(Number(now));

    // Use reference scripts when provided — avoids ~12KB of inline script bytes.
    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const withValidators =
      scriptRefs.treasury || scriptRefs.group
        ? afterPath.readFrom(
            [scriptRefs.treasury, scriptRefs.group].filter(Boolean) as UTxO[],
          )
        : afterPath.attach
            .MintingPolicy(treasuryValidator.mintTreasury)
            .attach.SpendingValidator(treasuryValidator.spendTreasury)
            .attach.SpendingValidator(groupValidator.spendGroup);

    const tx = yield* withValidators
      .readFrom([settingsUtxo])
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "exitGroup",
              error: String(e),
            }),
        ),
      );
    return tx;
  });
