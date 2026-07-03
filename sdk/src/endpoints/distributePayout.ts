import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
  UTxO,
  Assets,
  toUnit,
  credentialToAddress,
  validatorToRewardAddress,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { effectiveScriptRefs } from "../core/scripts.js";
import {
  GroupDatum,
  GroupSpendRedeemer,
  TreasuryDatum,
  TreasuryDatumSchema,
  TreasuryRedeemer,
  TreasuryWithdrawRedeemer,
} from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
import {
  getScriptAddress,
  parseGroupCip68Datum,
  buildGroupCip68Datum,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  contributableBalance,
  reserveTokenName,
} from "../core/utils/index.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";

/**
 * Creates an unsigned transaction for distributing a single ROSCA round.
 *
 * **Functionality:**
 * - Identifies the next round (group.last_distributed_round + 1).
 * - Spends the group UTxO to atomically increment last_distributed_round.
 * - Each member treasury contributes contribution_fee; the assigned borrower receives
 *   the full pot (contribution_fee × member_count).
 * - Updates all treasury datums (rounds_paid + 1).
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Distribute Round Configuration.
 * @returns Effect yielding TxSignBuilder.
 */
export type DistributePayoutConfig = {
  groupTokenSuffix: string;
  currentTime?: bigint; // POSIX ms — emulator.now() for emulator, omit for live
  // Reference script UTxOs (from deploy-scripts). When provided, the validator
  // script bytes are resolved from the on-chain UTxO rather than included inline,
  // keeping the transaction well under the 16KB Cardano size limit.
  scriptRefs?: {
    treasury?: UTxO;
    group?: UTxO;
  };
};

export const unsignedDistributePayoutTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: DistributePayoutConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const {
      treasuryValidator,
      treasuryPolicyId,
      groupPolicyId,
      groupValidator,
      settingsUnit,
    } = protocol;
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const { groupTokenSuffix } = config;

    const groupRefUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);

    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);
    const groupDatum = groupCip68.groupDatum;

    const groupRefAsset = Object.keys(groupUtxo.assets).find((k) =>
      k.startsWith(groupPolicyId),
    );
    if (!groupRefAsset)
      return yield* Effect.fail(
        new TransactionBuildError({
          operation: "distributeRound",
          error: "Group reference token not found in group UTxO",
        }),
      );
    const groupRefName = groupRefAsset.slice(groupPolicyId.length);

    if (!groupDatum.is_started) {
      return yield* Effect.fail(
        new TransactionBuildError({
          operation: "distributeRound",
          error: "Group has not been started — call startGroup first",
        }),
      );
    }
    if (groupDatum.num_rounds === 0n) {
      return yield* Effect.fail(
        new TransactionBuildError({
          operation: "distributeRound",
          error: "Group has zero intervals — call startGroup first",
        }),
      );
    }

    // round_number is monotonic and unbounded — a cycle is just num_rounds rounds and the
    // rotation wraps via roundNumber % num_rounds. There is no per-cycle cap (NextCycle is gone):
    // distribute simply keeps running, so the "next cycle" needs no separate trigger.
    const roundNumber = groupDatum.last_distributed_round + 1n;

    // Era-relative: round_number stays monotonic across recommit re-seals; the slot
    // mapping and schedule re-base at era_start_round.
    const eraRound = roundNumber - groupDatum.era_start_round;
    const currentSlot = Number(eraRound % groupDatum.num_rounds);
    // The borrower is resolved from the group's authoritative registry: the token name
    // paired with this round's slot (parallel lists; vacancy = rotation halt).
    const borrowerSlotIndex = groupDatum.member_slots.findIndex(
      (slot) => Number(slot) === currentSlot,
    );
    const borrowerTokenName =
      borrowerSlotIndex >= 0
        ? groupDatum.member_token_names[borrowerSlotIndex]
        : undefined;

    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );
    const rawTreasuryUtxos = yield* Effect.tryPromise({
      try: () => lucid.utxosAt(treasuryAddress),
      catch: (e) =>
        new TransactionBuildError({
          operation: "queryTreasury",
          error: String(e),
        }),
    });
    const treasuryUtxos = rawTreasuryUtxos.map(patchInlineDatum);

    const parsedStates = yield* Effect.all(
      treasuryUtxos.map((u) =>
        parseSafeDatum(u.datum, TreasuryDatumSchema).pipe(
          Effect.map((raw) => ({
            utxo: u,
            datum: raw as unknown as TreasuryDatum,
          })),
          Effect.orElse(() => Effect.succeed(null)),
        ),
      ),
      { concurrency: "unbounded" },
    );

    // Filter to TreasuryState UTxOs belonging to this group that are ready for this round.
    // The borrower is the member at this round's slot. Deferral was retired — the rotation
    // is fixed and turns are never reordered; "collect later" is handled by Pull mode
    // (the pot earmarks into the borrower's own treasury via claimable_balance).
    const memberStates: { utxo: UTxO; datum: TreasuryDatum }[] = [];
    let borrowerPaymentCred: string | undefined;

    for (const state of parsedStates) {
      if (!state || !("TreasuryState" in state.datum)) continue;
      const ts = state.datum.TreasuryState;
      if (ts.group_reference_tokenname !== groupRefName) continue;
      if (ts.rounds_paid !== roundNumber) continue;
      memberStates.push(state);
      if (ts.member_reference_tokenname === borrowerTokenName) {
        borrowerPaymentCred = ts.member_payment_credential;
      }
    }

    // Continuous model: defaulters are NOT referenced. The pot uses the cached
    // active_member_count and C4 is enforced by spent_set_complete (the spent set size must
    // equal active_member_count) + the per-input group-link check — so a defaulter simply sits
    // in its DefaultState UTxO, excluded, and the round proceeds around it.
    if (memberStates.length === 0) {
      return yield* Effect.fail(
        new TransactionBuildError({
          operation: "distributeRound",
          error: `No treasury UTxOs ready for round ${roundNumber}`,
        }),
      );
    }
    if (!borrowerPaymentCred) {
      return yield* Effect.fail(
        new TransactionBuildError({
          operation: "distributeRound",
          error: `No member found for current slot ${currentSlot}`,
        }),
      );
    }

    // Sort inputs lexicographically (same order Cardano uses for tx.inputs)
    memberStates.sort((a, b) => {
      const cmp = a.utxo.txHash.localeCompare(b.utxo.txHash);
      return cmp !== 0 ? cmp : a.utxo.outputIndex - b.utxo.outputIndex;
    });

    const grossPot = BigInt(memberStates.length) * groupDatum.contribution_fee;

    // 120 s buffer covers Blockfrost slot lag (observed up to ~30 s on Preprod).
    const VALIDITY_BUFFER_MS =
      lucid.config().network === "Custom" ? 0n : 120_000n;
    const currentTime =
      config.currentTime !== undefined
        ? config.currentTime
        : BigInt(Date.now()) - VALIDITY_BUFFER_MS;

    // The validator requires the tx lower-bound >= start_time + round * interval.
    const minValidFrom =
      groupDatum.start_time + eraRound * groupDatum.interval_length;

    // Pre-check on live networks only: if the raw wall-clock time is before the gate,
    // give a clear message rather than letting the validator fail cryptically.
    // Skipped on the emulator (Custom) where timing is driven by advanceBlock(), not Date.now().
    if (lucid.config().network !== "Custom") {
      const rawNow = BigInt(Date.now());
      if (rawNow < minValidFrom) {
        const waitSecs = Math.ceil(Number(minValidFrom - rawNow) / 1000);
        const opensAt = new Date(Number(minValidFrom)).toUTCString();
        return yield* Effect.fail(
          new TransactionBuildError({
            operation: "distributeRound",
            error: `Round ${roundNumber} is not yet open — opens in ~${waitSecs}s (at ${opensAt})`,
          }),
        );
      }
    }

    const rawValidFrom =
      currentTime > minValidFrom ? currentTime : minValidFrom;

    // Align the lower bound to the slot grid (1000 ms), same pattern as exitGroup. The
    // DefaultState transition pins grace_expires_at == get_lower_bound + grace_period_length,
    // so the same slot-aligned timestamp must feed both .validFrom and grace_expires_at — a
    // raw Date.now()-based value is sub-slot off and the ICS output datum is rejected. The
    // emulator passes an already-aligned currentTime.
    const validFrom =
      config.currentTime !== undefined
        ? rawValidFrom
        : rawValidFrom - (rawValidFrom % 1000n);

    const network = lucid.config().network!;
    const borrowerAddress = credentialToAddress(network, {
      type: "Key",
      hash: borrowerPaymentCred,
    });

    // Mode + contribution-asset locals (also used when building treasury outputs below).
    const isPull = groupDatum.payout_mode === "Pull";
    const isAdaContribution = groupDatum.contribution_fee_policyid === "";
    const contributionUnit = isAdaContribution
      ? "lovelace"
      : toUnit(
          groupDatum.contribution_fee_policyid,
          groupDatum.contribution_fee_assetname,
        );

    // ─── Reserve leg (round levy + stand-in draw) ─────────────────────────────
    // The reserve MUST be spent when the group configures a round levy; with levy
    // 0 it is spent only while a stand-in is active (the borrower gains the draw).
    // Levy-0/standin-0 rounds skip the leg entirely — the tx is unchanged.
    const roundLevy = groupDatum.reserve_round_levy;
    const reserveUnit = treasuryPolicyId + reserveTokenName(groupRefName);
    const reserveUtxoRaw = yield* resolveUtxoByUnit(lucid, reserveUnit);
    const reserveUtxo = patchInlineDatum(reserveUtxoRaw);
    const reserveDatumParsed = (yield* parseSafeDatum(
      reserveUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("ReserveState" in reserveDatumParsed)) {
      return yield* Effect.fail(
        new TransactionBuildError({
          operation: "distributeRound",
          error: "Expected ReserveState on the reserve UTxO",
        }),
      );
    }
    const standinIn = reserveDatumParsed.ReserveState.standin_rounds;
    const reserveNeeded = roundLevy > 0n || standinIn > 0n;
    const levyTotal = reserveNeeded
      ? roundLevy * BigInt(memberStates.length)
      : 0n;
    const reserveRawIn = reserveUtxo.assets[contributionUnit] ?? 0n;
    const reserveContributableIn = contributableBalance(
      reserveRawIn,
      isAdaContribution,
    );
    // One fee-unit per round while the counter is positive, capped by what the
    // pot (plus this round's levy) holds — a dry draw is 0 but still decrements.
    const drawCap = reserveContributableIn + levyTotal;
    const draw =
      reserveNeeded && standinIn > 0n
        ? groupDatum.contribution_fee < drawCap
          ? groupDatum.contribution_fee
          : drawCap < 0n
            ? 0n
            : drawCap
        : 0n;
    const standinOut = standinIn > 0n ? standinIn - 1n : 0n;
    // What the borrower actually receives this round.
    const payoutAmount = grossPot - levyTotal + draw;

    // The indexer legs: member treasuries plus (when needed) the reserve, sorted
    // lexicographically so input and output indices are both ascending on-chain.
    type ReserveLeg = { utxo: UTxO; datum: TreasuryDatum; isReserve: true };
    type Leg = { utxo: UTxO; datum: TreasuryDatum; isReserve?: boolean };
    const legs: Leg[] = [
      ...memberStates,
      ...(reserveNeeded
        ? [{ utxo: reserveUtxo, datum: reserveDatumParsed, isReserve: true } as ReserveLeg]
        : []),
    ].sort((a, b) => {
      const cmp = a.utxo.txHash.localeCompare(b.utxo.txHash);
      return cmp !== 0 ? cmp : a.utxo.outputIndex - b.utxo.outputIndex;
    });
    // ICS suppression at every cycle boundary (last round of any cycle) — generalises the old
    // single-cycle last round so a member drained at a boundary stays TreasuryState and can exit.
    const isCycleBoundary = (eraRound + 1n) % groupDatum.num_rounds === 0n;

    // Count members transitioning to DefaultState this round so the group output can decrement
    // active_member_count (mirrors the validator's count_default_outputs). Uses the same
    // per-member ICS test as the treasury output construction below.
    let icsCount = 0n;
    for (const state of memberStates) {
      if (!("TreasuryState" in state.datum)) continue;
      const ts = state.datum.TreasuryState;
      const isBorrowerTreasury =
        isPull && ts.member_reference_tokenname === borrowerTokenName;
      const inBal = state.utxo.assets[contributionUnit] ?? 0n;
      const outBal = isBorrowerTreasury
        ? inBal - groupDatum.contribution_fee + payoutAmount
        : inBal - groupDatum.contribution_fee;
      if (
        !isBorrowerTreasury &&
        contributableBalance(outBal, isAdaContribution) <
          groupDatum.contribution_fee &&
        !isCycleBoundary
      ) {
        icsCount += 1n;
      }
    }

    const updatedGroupDatum: GroupDatum = {
      ...groupDatum,
      last_distributed_round: roundNumber,
      // Members who transitioned to ICS this round leave the active set.
      active_member_count: groupDatum.active_member_count - icsCount,
    };

    // Output layout: [0] group, [1..n] indexer legs (treasuries + reserve, sorted
    // order), [n+1] borrower (Push only).
    const borrowerOutputIndex = BigInt(1 + legs.length);

    const allInputs = [groupUtxo, ...legs.map((s) => s.utxo)];

    const groupRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (indices: bigint[]) =>
        Data.to(
          {
            Distribute: {
              group_ref_token_name: groupRefName,
              group_input_index: indices[0],
              group_output_index: 0n,
              round_number: roundNumber,
            },
          },
          GroupSpendRedeemer,
        ),
      inputs: [groupUtxo],
    };

    // Withdraw-zero: each treasury spend carries only a constant coupling redeemer pointing
    // at the single withdrawal (index 0 in tx.withdrawals). The heavy round validation runs
    // once in the treasury `withdraw` handler via the DistributeWithdraw redeemer below.
    const treasurySpendRedeemer = Data.to(
      { DistributeRound: { withdrawal_index: 0n } },
      TreasuryRedeemer,
    );

    const distributeWithdrawRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (indices: bigint[]) => {
        const groupIdx = indices[0];
        const treasuryIndices = indices.slice(1);
        const treasuryOutIndices = treasuryIndices.map((_, i) => BigInt(i + 1));
        return Data.to(
          {
            round_number: roundNumber,
            group_ref_input_index: groupIdx,
            group_output_index: 0n,
            treasury_input_indices: treasuryIndices,
            treasury_output_indices: treasuryOutIndices,
            borrower_output_index: borrowerOutputIndex,
          },
          TreasuryWithdrawRedeemer,
        );
      },
      inputs: allInputs,
    };

    // The treasury's own stake credential (self-coupled withdraw-zero). Must be registered
    // on-chain (done at deploy time). A 0-ADA withdrawal here triggers the `withdraw` handler.
    const treasuryRewardAddress = validatorToRewardAddress(
      lucid.config().network!,
      treasuryValidator.spendTreasury,
    );

    // Build the transaction: group output first, then the indexer legs, then borrower
    const baseTxNoValidators = lucid
      .newTx()
      .collectFrom([groupUtxo], groupRedeemer)
      .collectFrom(
        legs.map((s) => s.utxo),
        treasurySpendRedeemer,
      )
      .withdraw(treasuryRewardAddress, 0n, distributeWithdrawRedeemer);

    // Use reference scripts when provided — avoids including ~15KB of script bytes
    // inline, keeping the tx under Cardano's 16,384-byte size limit.
    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const baseTx =
      scriptRefs.treasury || scriptRefs.group
        ? baseTxNoValidators.readFrom(
            [scriptRefs.treasury, scriptRefs.group].filter(Boolean) as UTxO[],
          )
        : baseTxNoValidators.attach
            .SpendingValidator(groupValidator.spendGroup)
            .attach.SpendingValidator(treasuryValidator.spendTreasury);

    const baseTxWithGroup = baseTx.pay.ToContract(
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

    // isPull / isAdaContribution / contributionUnit / isCycleBoundary computed above.
    // Outputs are built in LEG order (sorted), so the on-chain indexer sees
    // ascending input AND output indices — the reserve leg lands wherever its
    // outRef sorts among the member treasuries.
    const withTreasuryOutputs = legs.reduce((tx, state) => {
      if (state.isReserve) {
        const updatedReserve: TreasuryDatum = {
          ReserveState: {
            ...(state.datum as { ReserveState: { group_reference_tokenname: string; standin_rounds: bigint } })
              .ReserveState,
            standin_rounds: standinOut,
          },
        };
        const reserveOutBalance = reserveRawIn + levyTotal - draw;
        // ADA groups adjust lovelace; token groups adjust the token (omitting a
        // zero entry) and keep lovelace unchanged.
        const reserveOutAssets: Assets = isAdaContribution
          ? { ...state.utxo.assets, lovelace: reserveOutBalance }
          : {
              ...Object.fromEntries(
                Object.entries(state.utxo.assets).filter(
                  ([k]) => k !== contributionUnit,
                ),
              ),
              ...(reserveOutBalance > 0n
                ? { [contributionUnit]: reserveOutBalance }
                : {}),
            };
        return tx.pay.ToContract(
          state.utxo.address,
          { kind: "inline", value: Data.to(updatedReserve, TreasuryDatum) },
          reserveOutAssets,
        );
      }
      if (!("TreasuryState" in state.datum)) return tx;
      const ts = state.datum.TreasuryState;
      const memberToken = toUnit(
        treasuryPolicyId,
        ts.member_reference_tokenname,
      );
      // Under Pull, the borrower's own treasury (registry-resolved) is credited the pot.
      const isBorrowerTreasury =
        isPull && ts.member_reference_tokenname === borrowerTokenName;
      // Balance is measured in the contribution asset (lovelace for ADA groups). Every
      // member is debited the fee; the Pull borrower is also credited the pot, so its
      // balance rises and it never transitions to ICS.
      const inputBal = state.utxo.assets[contributionUnit] ?? 0n;
      const outputBal = isBorrowerTreasury
        ? inputBal - groupDatum.contribution_fee + payoutAmount
        : inputBal - groupDatum.contribution_fee;
      // ICS transition is decided on the *contributable* balance (lovelace − reserve for
      // ADA groups), mirroring the validator: a member whose spendable balance drops below
      // a round's fee defaults — but the min-ADA reserve is not "spendable", so it must be
      // excluded or an ADA member would be wrongly kept in TreasuryState (datum mismatch).
      const outputContributable = contributableBalance(
        outputBal,
        isAdaContribution,
      );
      const transitionToIcs =
        !isBorrowerTreasury &&
        outputContributable < groupDatum.contribution_fee &&
        !isCycleBoundary;

      const updatedDatum: TreasuryDatum = transitionToIcs
        ? {
            DefaultState: {
              group_reference_tokenname: ts.group_reference_tokenname,
              member_reference_tokenname: ts.member_reference_tokenname,
              grace_expires_at: validFrom + groupDatum.grace_period_length,
              grace_extensions_used: 0n,
              rounds_paid: roundNumber + 1n,
              member_payment_credential: ts.member_payment_credential,
              // A defaulting member is always a non-borrower, so the earmark carries
              // through unchanged (the funds stay in the UTxO value either way).
              claimable_balance: ts.claimable_balance,
            },
          }
        : {
            TreasuryState: {
              ...ts,
              rounds_paid: roundNumber + 1n,
              // Pull: earmark the pot into the borrower's own treasury. Others preserve it.
              ...(isBorrowerTreasury
                ? { claimable_balance: ts.claimable_balance + payoutAmount }
                : {}),
            },
          };
      // ADA groups: deduct from lovelace. Token groups: keep min-UTxO lovelace
      // unchanged and reduce the contribution token (omit if it reaches zero).
      const outAssets: Assets = isAdaContribution
        ? { lovelace: outputBal, [memberToken]: 1n }
        : {
            lovelace: state.utxo.assets.lovelace,
            [memberToken]: 1n,
            ...(outputBal > 0n ? { [contributionUnit]: outputBal } : {}),
          };
      return tx.pay.ToContract(
        state.utxo.address,
        { kind: "inline", value: Data.to(updatedDatum, TreasuryDatum) },
        outAssets,
      );
    }, baseTxWithGroup);

    // Borrower receives the pot in the contribution asset (+ min-UTxO ADA for token groups).
    const borrowerAssets: Assets = isAdaContribution
      ? { lovelace: payoutAmount }
      : { lovelace: 2_000_000n, [contributionUnit]: payoutAmount };

    // Push: pay the pot to the borrower's wallet. Pull: the pot was earmarked into the
    // borrower's own treasury above, so there is no wallet output.
    const withBorrower = isPull
      ? withTreasuryOutputs
      : withTreasuryOutputs.pay.ToAddress(borrowerAddress, borrowerAssets);

    const tx = yield* withBorrower
      .validFrom(Number(validFrom))
      .readFrom([settingsUtxo])
      .completeProgram(
        lucid.config().network === "Custom" ? { localUPLCEval: false } : {},
      )
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "distributeRound",
              error: String(e),
            }),
        ),
      );

    return tx;
  });
