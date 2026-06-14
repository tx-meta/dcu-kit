import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
  paymentCredentialOf,
  credentialToAddress,
  Assets,
  toUnit,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { effectiveScriptRefs } from "../core/scripts.js";
import {
  GroupDatum,
  TreasuryDatum,
  TreasuryRedeemer,
  GroupSpendRedeemer,
} from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
import {
  getScriptAddress,
  parseGroupCip68Datum,
  buildGroupCip68Datum,
  getWalletAddress,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  MIN_ADA_RESERVE,
} from "../core/utils/index.js";
import {
  DcuError,
  UtxoNotFoundError,
  TransactionBuildError,
} from "../core/errors.js";

/**
 * Creates an unsigned transaction for joining a Group.
 *
 * **Functionality:**
 * - Mints a Treasury Membership NFT (unique to the Account).
 * - Locks the contribution amount (Lovelace) in the Treasury script.
 * - Updates the Group state (increments member count/assigns slot).
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Join Group Configuration.
 * @returns Effect yielding a TxSignBuilder.
 *
 * @example
 * ```typescript
 * const program = unsignedJoinGroupTxProgram(lucid,
 *   { groupUtxo, accountUtxo, adminUtxo, contributionAmount }
 * );
 * ```
 */
export type JoinGroupConfig = {
  groupTokenSuffix: string;
  accountTokenSuffix: string;
  currentTime?: bigint; // POSIX ms — emulator.now() for emulator, Date.now() for live
  fundingUtxos?: UTxO[]; // plain ADA UTxOs to pre-supply for coin selection (live network)
  // Override the lovelace locked in the treasury UTxO (ADA-contribution groups). Defaults to
  // contribution_fee × collateral_rounds (the validator floor). Prefund more rounds by setting
  // a larger value; deposits are never capped.
  overrideDepositLovelace?: bigint;
  // Override the contribution-token amount locked in the treasury UTxO (native-token groups).
  // Defaults to contribution_fee × collateral_rounds. Prefund more rounds by setting a larger value.
  depositContributionAmount?: bigint;
  // Reference script UTxOs (from deploy-scripts). When provided, the validator
  // script bytes are resolved from the on-chain UTxO rather than included inline,
  // keeping the transaction well under the 16KB Cardano size limit.
  scriptRefs?: {
    treasury?: UTxO; // UTxO with scriptRef for treasury validator
    group?: UTxO; // UTxO with scriptRef for group validator
  };
};

export const unsignedJoinGroupTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: JoinGroupConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const {
      groupValidator,
      groupPolicyId,
      accountPolicyId,
      treasuryValidator,
      treasuryPolicyId,
      settingsUnit,
    } = protocol;
    const {
      groupTokenSuffix,
      accountTokenSuffix,
      currentTime,
      fundingUtxos,
      overrideDepositLovelace,
    } = config;

    const groupRefUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    const accountUserUnit =
      accountPolicyId + assetNameLabels.prefix222 + accountTokenSuffix;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const accountUtxoRaw = yield* resolveUtxoByUnit(lucid, accountUserUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const accountUtxo = patchInlineDatum(accountUtxoRaw);
    // The treasury validator reads the trusted policies from the settings UTxO, so it
    // must be present as a reference input on every treasury transaction.
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);
    const groupDatum = groupCip68.groupDatum;

    const assignedSlot = groupDatum.member_count;

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

    const accountAssetEntry = Object.keys(accountUtxo.assets).find((k) =>
      k.startsWith(accountPolicyId),
    );
    if (!accountAssetEntry)
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: "Account NFT",
          address: accountUtxo.address,
        }),
      );
    const accountAssetName = accountAssetEntry.slice(accountPolicyId.length);

    const updatedGroupDatum: GroupDatum = {
      ...groupDatum,
      member_count: groupDatum.member_count + 1n,
      member_token_names: [accountAssetName, ...groupDatum.member_token_names],
    };
    const treasuryMemberToken = toUnit(treasuryPolicyId, accountAssetName);

    const mintingAssets: Assets = { [treasuryMemberToken]: 1n };
    // Lock the configured collateral floor — contribution_fee × collateral_rounds — in the
    // contribution asset. collateral_rounds = 1 is PerRound (lock just the first round and top up
    // each cycle); max_members is FullUpfront. This matches the validator's `fees_locked` floor and
    // honours the member's chosen mode rather than always forcing the full cycle. Deposits are never
    // capped — a member may prefund more by overriding (overrideDepositLovelace for ADA, or
    // depositContributionAmount for native-token groups). For ADA the asset is lovelace; for
    // native-token groups we lock the token plus 2 ADA min-UTxO.
    const isAdaContribution = groupDatum.contribution_fee_policyid === "";
    const collateralFloor =
      groupDatum.collateral_rounds * groupDatum.contribution_fee;
    // For ADA groups the validator measures a *contributable* balance = lovelace −
    // MIN_ADA_RESERVE, so the deposit must carry the reserve ON TOP of the collateral
    // floor (the reserve keeps the membership token's min-ADA covered as the balance
    // drains to 0 on the final round). Token groups keep the floor in the token plus a
    // flat 2 ADA min-UTxO (the reserve concept is ADA-only). See [[contributableBalance]].
    const treasuryLovelace =
      overrideDepositLovelace !== undefined
        ? overrideDepositLovelace
        : isAdaContribution
          ? collateralFloor + MIN_ADA_RESERVE
          : 2_000_000n;
    const treasuryAssets: Assets = {
      lovelace: treasuryLovelace,
      [treasuryMemberToken]: 1n,
    };
    if (!isAdaContribution) {
      const contributionUnit = toUnit(
        groupDatum.contribution_fee_policyid,
        groupDatum.contribution_fee_assetname,
      );
      treasuryAssets[contributionUnit] =
        config.depositContributionAmount ?? collateralFloor;
    }

    const address = yield* getWalletAddress(lucid);
    const memberPaymentCredential = paymentCredentialOf(address).hash;

    const rawNow =
      currentTime !== undefined ? currentTime : BigInt(Date.now()) - 120_000n;
    const now = currentTime !== undefined ? rawNow : rawNow - (rawNow % 1000n);

    const treasuryDatum: TreasuryDatum = {
      TreasuryState: {
        group_reference_tokenname: groupRefName,
        member_reference_tokenname: accountAssetName,
        assigned_slot: assignedSlot,
        rounds_paid: 0n,
        member_payment_credential: memberPaymentCredential,
        // Fresh member — nothing earmarked yet (0 under both Push and Pull).
        claimable_balance: 0n,
      },
    };

    const groupRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            Join: {
              group_ref_token_name: groupRefName,
              member_token_name: accountAssetName,
              group_input_index: inputIndices[0],
              group_output_index: 0n,
            },
          },
          GroupSpendRedeemer,
        ),
      inputs: [groupUtxo],
    };

    const treasuryRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            JoinGroup: {
              group_ref_input_index: inputIndices[0],
              group_output_index: 0n,
              member_input_index: inputIndices[1],
              treasury_output_index: 1n,
            },
          },
          TreasuryRedeemer,
        ),
      inputs: [groupUtxo, accountUtxo],
    };

    const groupAddress = yield* getScriptAddress(
      lucid,
      groupValidator.spendGroup,
    );
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );

    // Route joining_fee to admin wallet when non-zero.
    // Aiken checks: list.any(outputs, o -> pkh == creator_payment_credential && qty >= joining_fee)
    const network = lucid.config().network!;
    const adminFeeAddress =
      groupDatum.joining_fee > 0n
        ? credentialToAddress(network, {
            type: "Key",
            hash: groupDatum.creator_payment_credential,
          })
        : null;
    const adminFeeAssets: Assets | null =
      groupDatum.joining_fee > 0n
        ? groupDatum.joining_fee_policyid === ""
          ? { lovelace: groupDatum.joining_fee }
          : {
              lovelace: 2_000_000n,
              [groupDatum.joining_fee_policyid +
              groupDatum.joining_fee_assetname]: groupDatum.joining_fee,
            }
        : null;

    const baseTx = lucid
      .newTx()
      .collectFrom([groupUtxo], groupRedeemer)
      .collectFrom([accountUtxo])
      .mintAssets(mintingAssets, treasuryRedeemer)
      .pay.ToContract(
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
      )
      .pay.ToContract(
        treasuryAddress,
        { kind: "inline", value: Data.to(treasuryDatum, TreasuryDatum) },
        treasuryAssets,
      )
      // Return only the account token + minimum lovelace.
      // accountUtxo may hold hundreds of ADA (e.g. if the wallet's change from
      // create-account landed in the same UTxO). Returning accountUtxo.assets
      // intact makes the account UTxO a net-zero ADA contributor — the same ADA
      // goes in and straight back out, leaving no surplus for the ~22 ADA treasury
      // deposit. Paying back min lovelace (2 ADA) frees the excess for coin
      // selection via the change output.
      .pay.ToAddress(address, {
        lovelace: 2_000_000n,
        [accountAssetEntry]: 1n,
      });

    // collectFrom([]) throws EMPTY_UTXO in Lucid Evolution — only add when non-empty
    const withFunding =
      fundingUtxos && fundingUtxos.length > 0
        ? baseTx.collectFrom(fundingUtxos)
        : baseTx;

    const withFee =
      adminFeeAddress && adminFeeAssets
        ? withFunding.pay.ToAddress(adminFeeAddress, adminFeeAssets)
        : withFunding;

    // Use reference scripts when provided — avoids including ~12KB of script bytes
    // inline, keeping the tx under Cardano's 16,384-byte size limit.
    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const withValidators =
      scriptRefs.treasury || scriptRefs.group
        ? withFee.readFrom(
            [scriptRefs.treasury, scriptRefs.group].filter(Boolean) as UTxO[],
          )
        : withFee.attach
            .MintingPolicy(treasuryValidator.mintTreasury)
            .attach.SpendingValidator(groupValidator.spendGroup);

    const tx = yield* withValidators
      .readFrom([settingsUtxo])
      .addSigner(address)
      .validFrom(Number(now))
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "joinGroup",
              error: String(e),
            }),
        ),
      );
    return tx;
  });
