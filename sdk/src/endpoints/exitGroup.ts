
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
import {
    GroupDatum,
    GroupSpendRedeemer,
    TreasuryDatum,
    TreasuryDatumSchema,
    TreasuryRedeemer
} from "../core/types.js";
import { treasuryValidator, treasuryPolicyId, groupValidator, groupPolicyId, accountPolicyId } from "../core/validators/constants.js";
import { DcuError, InvalidDatumError, TransactionBuildError, UtxoNotFoundError } from "../core/errors.js";
import { getScriptAddress, getWalletAddress, parseSafeDatum, patchInlineDatum, assetNameLabels, resolveUtxoByUnit } from "../core/utils/index.js";

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
  lucid: LucidEvolution,
  config: ExitGroupConfig
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupTokenSuffix, currentTime } = config;

    const groupRefUnit = groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);

    const treasuryAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);
    const allTreasury     = yield* Effect.tryPromise({
        try: () => lucid.utxosAt(treasuryAddress),
        catch: (e) => new TransactionBuildError({ operation: "queryTreasury", error: String(e) }),
    });

    // Build the set of candidate member_reference_tokennames to match against.
    // If the caller provides an explicit suffix, use that single candidate.
    // Otherwise scan ALL (222) account tokens in the wallet — this handles the common
    // case where a wallet holds multiple account tokens from different sessions and the
    // "first" token found is not the one used to join this group.
    const candidateRefNames: Set<string> = yield* (config.accountTokenSuffix
        ? Effect.succeed(new Set([assetNameLabels.prefix222 + config.accountTokenSuffix]))
        : Effect.tryPromise({
              try: () => lucid.wallet().getUtxos(),
              catch: (e) => new TransactionBuildError({ operation: "getWalletUtxos", error: String(e) }),
          }).pipe(Effect.map(walletUtxos => new Set(
              walletUtxos
                  .flatMap(u => Object.keys(u.assets))
                  .filter(k => k.startsWith(accountPolicyId + assetNameLabels.prefix222))
                  .map(k => k.slice(accountPolicyId.length))  // keep prefix222 + suffix
          )))
    );

    // Find the treasury UTxO whose member_reference_tokenname is in our candidate set.
    // Use an inner Effect.gen so `return yield* Effect.fail(...)` reliably aborts the scan
    // (mutable let + for..of + yield* in the outer generator has subtle propagation issues).
    const { treasuryUtxoRaw, memberRefName } = yield* Effect.gen(function* () {
        for (const u of allTreasury) {
            const parsed = yield* parseSafeDatum(u.datum, TreasuryDatumSchema).pipe(
                Effect.map(d => d as unknown as TreasuryDatum),
                Effect.orElse(() => Effect.succeed(null)),
            );
            if (parsed && 'TreasuryState' in parsed && candidateRefNames.has(parsed.TreasuryState.member_reference_tokenname)) {
                return { treasuryUtxoRaw: u, memberRefName: parsed.TreasuryState.member_reference_tokenname as string };
            }
        }
        return yield* Effect.fail(new UtxoNotFoundError({
            tokenName: [...candidateRefNames].join(' | '),
            address: treasuryAddress,
        }));
    });

    const accountUserUnit = accountPolicyId + memberRefName;
    const accountUtxoRaw  = yield* resolveUtxoByUnit(lucid, accountUserUnit);
    const accountUtxo = patchInlineDatum(accountUtxoRaw);
    const treasuryUtxo  = patchInlineDatum(treasuryUtxoRaw);
    const treasuryDatum = (yield* parseSafeDatum(treasuryUtxo.datum, TreasuryDatumSchema)) as unknown as TreasuryDatum;
    if (!('TreasuryState' in treasuryDatum)) return yield* Effect.fail(new InvalidDatumError({ field: "treasuryDatum", reason: "Expected TreasuryState" }));

    const groupDatum = yield* parseSafeDatum(groupUtxo.datum, GroupDatum);

    const groupRefAssetEntry = Object.keys(groupUtxo.assets).find(k => k.startsWith(groupPolicyId!));
    if (!groupRefAssetEntry) return yield* Effect.fail(new UtxoNotFoundError({ tokenName: "GroupReference (100)", address: groupUtxo.address }));
    const groupRefName = groupRefAssetEntry.slice(groupPolicyId!.length);

    const memberToken = toUnit(treasuryPolicyId!, memberRefName);
    const penaltyAssets: Assets = { lovelace: 2_000_000n + groupDatum.penalty_fee, [memberToken]: 1n };
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
    const rawNow = currentTime !== undefined
        ? currentTime
        : BigInt(Date.now()) - 120_000n;
    const now = currentTime !== undefined
        ? rawNow
        : rawNow - rawNow % 1000n;
    const maturityTime = groupDatum.start_time + (groupDatum.num_intervals * groupDatum.interval_length);
    const isEarlyExit = groupDatum.is_active && groupDatum.start_time <= now && (now < maturityTime);

    // Updated Group datum: decrement member count and remove member from registry
    const updatedGroupDatum: GroupDatum = {
        ...groupDatum,
        member_count: groupDatum.member_count - 1n,
        member_token_names: groupDatum.member_token_names.filter(n => n !== memberRefName),
    };

    // Group validator redeemer: MemberExit (no admin required)
    const groupRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            MemberExit: {
                group_ref_token_name: groupRefName,
                member_token_name: memberRefName,
                group_input_index: inputIndices[0],
                group_output_index: 0n
            }
        }, GroupSpendRedeemer),
        inputs: [groupUtxo]
    };

    // Treasury validator spend redeemer: ExitGroup
    // Output layout: [0] Group UTxO, [1] Penalty (early exit only)
    const treasurySpendRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) => Data.to({
            ExitGroup: {
                group_ref_input_index: inputIndices[0],
                group_output_index: 0n,
                member_input_index: inputIndices[1],
                treasury_input_index: inputIndices[2],
                penalty_output_index: isEarlyExit ? 1n : 0n
            }
        }, TreasuryRedeemer),
        inputs: [groupUtxo, accountUtxo, treasuryUtxo]
    };

    // Mint redeemer for mature exit burn — the mint handler (ExitGroup branch) calls
    // validate_terminate_group which ignores all index fields; any valid ExitGroup
    // redeemer works here. Using a plain Data value avoids sharing a RedeemerBuilder
    // between spend and mint contexts, which can cause index resolution issues in Lucid.
    const mintBurnRedeemer = Data.to({
        ExitGroup: {
            group_ref_input_index: 0n,
            group_output_index: 0n,
            member_input_index: 0n,
            treasury_input_index: 0n,
            penalty_output_index: 0n
        }
    }, TreasuryRedeemer);

    const address = yield* getWalletAddress(lucid);
    const groupAddress = yield* getScriptAddress(lucid, groupValidator.spendGroup);

    const penaltyDatum: TreasuryDatum = {
        PenaltyState: {
            group_reference_tokenname: treasuryDatum.TreasuryState.group_reference_tokenname,
            member_reference_tokenname: treasuryDatum.TreasuryState.member_reference_tokenname
        }
    };

    const baseTx = lucid.newTx()
        .collectFrom([groupUtxo], groupRedeemer)
        .collectFrom([accountUtxo])
        .collectFrom([treasuryUtxo], treasurySpendRedeemer)
        .addSigner(address)
        .pay.ToContract(groupAddress, { kind: "inline", value: Data.to(updatedGroupDatum, GroupDatum) }, groupUtxo.assets);

    const afterPath = (isEarlyExit
        ? baseTx.pay.ToContract(treasuryAddress, { kind: "inline", value: Data.to(penaltyDatum, TreasuryDatum) }, penaltyAssets)
        : baseTx.mintAssets(burnAssets, mintBurnRedeemer))
        .validFrom(Number(now));

    // Use reference scripts when provided — avoids ~12KB of inline script bytes.
    const withValidators = (config.scriptRefs?.treasury || config.scriptRefs?.group)
        ? afterPath.readFrom(
              [config.scriptRefs?.treasury, config.scriptRefs?.group].filter(Boolean) as UTxO[]
          )
        : afterPath
              .attach.MintingPolicy(treasuryValidator.mintTreasury)
              .attach.SpendingValidator(treasuryValidator.spendTreasury)
              .attach.SpendingValidator(groupValidator.spendGroup);

    const tx = yield* withValidators
        .completeProgram()
        .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "exitGroup", error: String(e) })));
    return tx;
  });
