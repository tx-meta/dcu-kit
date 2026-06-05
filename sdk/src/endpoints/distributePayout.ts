import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
  UTxO,
  Assets,
  toUnit,
  credentialToAddress,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  GroupDatum,
  GroupSpendRedeemer,
  TreasuryDatum,
  TreasuryDatumSchema,
  TreasuryRedeemer,
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

    const roundNumber = groupDatum.last_distributed_round + 1n;
    if (roundNumber >= groupDatum.num_rounds) {
      return yield* Effect.fail(
        new TransactionBuildError({
          operation: "distributeRound",
          error: `All ${groupDatum.num_rounds} rounds have been distributed (rounds 0–${groupDatum.num_rounds - 1n} complete). Group is mature — members can now call exit-group.`,
        }),
      );
    }

    const currentSlot = Number(roundNumber % groupDatum.num_rounds);

    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );
    const groupAddress = yield* getScriptAddress(
      lucid,
      groupValidator.spendGroup,
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
      if (Number(ts.assigned_slot) === currentSlot) {
        borrowerPaymentCred = ts.member_payment_credential;
      }
    }

    // Defaulters (DefaultState / PenaltyState) for this group must be presented as
    // reference inputs so the validator's complete-member-set check passes. They do not
    // contribute, so they are excluded from memberStates and the pro-rata payout.
    const defaulterUtxos: UTxO[] = [];
    for (const state of parsedStates) {
      if (!state) continue;
      const d = state.datum;
      const grt =
        "DefaultState" in d
          ? d.DefaultState.group_reference_tokenname
          : "PenaltyState" in d
            ? d.PenaltyState.group_reference_tokenname
            : undefined;
      if (grt === groupRefName) defaulterUtxos.push(state.utxo);
    }

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

    const effectiveSlot = currentSlot;

    // Sort inputs lexicographically (same order Cardano uses for tx.inputs)
    memberStates.sort((a, b) => {
      const cmp = a.utxo.txHash.localeCompare(b.utxo.txHash);
      return cmp !== 0 ? cmp : a.utxo.outputIndex - b.utxo.outputIndex;
    });

    const payoutAmount =
      BigInt(memberStates.length) * groupDatum.contribution_fee;

    // 120 s buffer covers Blockfrost slot lag (observed up to ~30 s on Preprod).
    const VALIDITY_BUFFER_MS =
      lucid.config().network === "Custom" ? 0n : 120_000n;
    const currentTime =
      config.currentTime !== undefined
        ? config.currentTime
        : BigInt(Date.now()) - VALIDITY_BUFFER_MS;

    // The validator requires the tx lower-bound >= start_time + round * interval.
    const minValidFrom =
      groupDatum.start_time + roundNumber * groupDatum.interval_length;

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

    const updatedGroupDatum: GroupDatum = {
      ...groupDatum,
      last_distributed_round: roundNumber,
    };

    // Output layout: [0] group, [1..n] treasury outputs, [n+1] borrower
    const borrowerOutputIndex = BigInt(1 + memberStates.length);

    const allInputs = [groupUtxo, ...memberStates.map((s) => s.utxo)];

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

    const treasuryRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (indices: bigint[]) => {
        const groupIdx = indices[0];
        const treasuryIndices = indices.slice(1);
        const treasuryOutIndices = treasuryIndices.map((_, i) => BigInt(i + 1));
        return Data.to(
          {
            DistributeRound: {
              round_number: roundNumber,
              group_ref_input_index: groupIdx,
              group_output_index: 0n,
              treasury_input_indices: treasuryIndices,
              treasury_output_indices: treasuryOutIndices,
              borrower_output_index: borrowerOutputIndex,
            },
          },
          TreasuryRedeemer,
        );
      },
      inputs: allInputs,
    };

    // Build the transaction: group output first, then treasury outputs, then borrower
    const baseTxNoValidators = lucid
      .newTx()
      .collectFrom([groupUtxo], groupRedeemer)
      .collectFrom(
        memberStates.map((s) => s.utxo),
        treasuryRedeemer,
      );

    // Use reference scripts when provided — avoids including ~15KB of script bytes
    // inline, keeping the tx under Cardano's 16,384-byte size limit.
    const baseTx =
      config.scriptRefs?.treasury || config.scriptRefs?.group
        ? baseTxNoValidators.readFrom(
            [config.scriptRefs?.treasury, config.scriptRefs?.group].filter(
              Boolean,
            ) as UTxO[],
          )
        : baseTxNoValidators.attach
            .SpendingValidator(groupValidator.spendGroup)
            .attach.SpendingValidator(treasuryValidator.spendTreasury);

    const baseTxWithGroup = baseTx.pay.ToContract(
      groupAddress,
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

    const isLastRound = roundNumber + 1n === groupDatum.num_rounds;

    // Pull mode: the pot is earmarked into the borrower's OWN treasury (claimable_balance)
    // instead of paid to a wallet. Push mode keeps the direct wallet output.
    const isPull = groupDatum.payout_mode === "Pull";

    // The contribution asset may be ADA (lovelace) or any native token.
    const isAdaContribution = groupDatum.contribution_fee_policyid === "";
    const contributionUnit = isAdaContribution
      ? "lovelace"
      : toUnit(
          groupDatum.contribution_fee_policyid,
          groupDatum.contribution_fee_assetname,
        );

    const withTreasuryOutputs = memberStates.reduce((tx, state) => {
      if (!("TreasuryState" in state.datum)) return tx;
      const ts = state.datum.TreasuryState;
      const memberToken = toUnit(
        treasuryPolicyId,
        ts.member_reference_tokenname,
      );
      // Under Pull, the borrower's own treasury (slot == effectiveSlot) is credited the pot.
      const isBorrowerTreasury =
        isPull && Number(ts.assigned_slot) === effectiveSlot;
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
        !isLastRound;

      const updatedDatum: TreasuryDatum = transitionToIcs
        ? {
            DefaultState: {
              group_reference_tokenname: ts.group_reference_tokenname,
              member_reference_tokenname: ts.member_reference_tokenname,
              grace_expires_at: validFrom + groupDatum.grace_period_length,
              grace_extensions_used: 0n,
              rounds_paid: roundNumber + 1n,
              assigned_slot: ts.assigned_slot,
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
        treasuryAddress,
        { kind: "inline", value: Data.to(updatedDatum, TreasuryDatum) },
        outAssets,
      );
    }, baseTxWithGroup);

    // Borrower receives the pot in the contribution asset (+ min-UTxO ADA for token groups).
    const borrowerAssets: Assets = isAdaContribution
      ? { lovelace: payoutAmount }
      : { lovelace: 2_000_000n, [contributionUnit]: payoutAmount };

    // Present defaulters as reference inputs so the complete-member-set check is satisfied.
    const withRefs =
      defaulterUtxos.length > 0
        ? withTreasuryOutputs.readFrom(defaulterUtxos)
        : withTreasuryOutputs;

    // Push: pay the pot to the borrower's wallet. Pull: the pot was earmarked into the
    // borrower's own treasury above, so there is no wallet output.
    const withBorrower = isPull
      ? withRefs
      : withRefs.pay.ToAddress(borrowerAddress, borrowerAssets);

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
