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
import { TreasuryRedeemer, ReserveAction } from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
import {
  getWalletAddress,
  parseGroupCip68Datum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  reserveTokenName,
} from "../core/utils/index.js";
import {
  ConfigurationError,
  DcuError,
  TransactionBuildError,
} from "../core/errors.js";

/**
 * Creates an unsigned transaction donating to a group's mutual reserve.
 *
 * **Functionality:**
 * - Spends the group's ReserveState UTxO with the increase-only ReserveTopUp
 *   redeemer: the contribution-asset balance strictly grows, everything else
 *   (datum, address, identity token) is pinned on-chain.
 * - Permissionless — anyone may donate (harambee); no membership required.
 * - The group UTxO rides as a read-only reference input (it authenticates the
 *   contribution asset for the validator).
 *
 * @param lucid - Lucid instance with the donor wallet selected.
 * @param config - TopUpReserve Configuration.
 * @returns Effect yielding a TxSignBuilder ready for signing.
 */
export type TopUpReserveConfig = {
  groupTokenSuffix: string;
  /** Donation amount in the group's CONTRIBUTION asset (lovelace for ADA groups). */
  amount: bigint;
  /** Deployed treasury reference script — the treasury no longer fits inline. */
  scriptRefs?: ScriptRefs;
};

export const unsignedTopUpReserveTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: TopUpReserveConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { treasuryValidator, treasuryPolicyId, groupPolicyId, settingsUnit } =
      protocol;
    const { groupTokenSuffix, amount } = config;

    if (amount <= 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "amount",
          message: "top-up amount must be positive",
        }),
      );
    }

    const groupRefName = assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUtxoRaw = yield* resolveUtxoByUnit(
      lucid,
      groupPolicyId + groupRefName,
    );
    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);
    const groupDatum = groupCip68.groupDatum;
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);

    const reserveUnit = treasuryPolicyId + reserveTokenName(groupRefName);
    const reserveUtxoRaw = yield* resolveUtxoByUnit(lucid, reserveUnit);
    const reserveUtxo = patchInlineDatum(reserveUtxoRaw);

    const contributionUnit =
      groupDatum.contribution_fee_policyid === ""
        ? "lovelace"
        : toUnit(
            groupDatum.contribution_fee_policyid,
            groupDatum.contribution_fee_assetname,
          );
    const reserveOutAssets: Assets = {
      ...reserveUtxo.assets,
      [contributionUnit]: (reserveUtxo.assets[contributionUnit] ?? 0n) + amount,
    };

    // Treasury split: field-less spend literal; the RESERVE TopUpAction covers
    // the reserve UTxO being spent.
    const topUpAction: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (indices: bigint[]) =>
        Data.to(
          {
            TopUpAction: {
              covered_inputs: [indices[0]],
              reserve_output_index: 0n,
            },
          },
          ReserveAction,
        ),
      inputs: [reserveUtxo],
    };

    const address = yield* getWalletAddress(lucid);

    const baseTx = lucid
      .newTx()
      .collectFrom([reserveUtxo], Data.to("ReserveTopUp", TreasuryRedeemer))
      .pay.ToContract(
        reserveUtxo.address,
        // Datum is frozen by the validator — carry it through unchanged.
        { kind: "inline", value: reserveUtxo.datum! },
        reserveOutAssets,
      )
      .addSigner(address)
      .readFrom([groupUtxo, settingsUtxo]);

    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const network = lucid.config().network!;
    const withValidator = attachFamilyWithdrawal(
      scriptRefs.treasury
        ? baseTx.readFrom([scriptRefs.treasury])
        : baseTx.attach.SpendingValidator(treasuryValidator.spendTreasury),
      protocol,
      network,
      "reserve",
      topUpAction,
      scriptRefs,
    );

    const tx = yield* withValidator.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "topUpReserve",
            error: String(e),
          }),
      ),
    );
    return tx;
  });
