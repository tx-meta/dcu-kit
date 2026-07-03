import {
  Data,
  TxSignBuilder,
  LucidEvolution,
  OutRef,
  RedeemerBuilder,
  Constr,
  Assets,
  Script,
  UTxO,
  toUnit,
  fromText,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { effectiveScriptRefs } from "../core/scripts.js";
import { Effect } from "effect";
import { GroupDatum, TreasuryDatum, TreasuryRedeemer } from "../core/types.js";
import {
  buildGroupCip68Datum,
  getScriptAddress,
  getWalletAddress,
  createCip68TokenNames,
  resolveUtxoByOutRef,
  resolveUtxoByUnit,
  assetNameLabels,
  reserveTokenName,
} from "../core/utils/index.js";
import {
  ConfigurationError,
  DcuError,
  TransactionBuildError,
  ValidatorNotFoundError,
} from "../core/errors.js";
import { Protocol } from "../core/validators/constants.js";

/**
 * Creates an unsigned transaction for creating a new DCU Group.
 *
 * **Functionality:**
 * - Mints a unique CIP-68 pair of Group tokens (Reference 100 + Admin Auth 222).
 * - Locks the Reference NFT in the Group script with the provided configuration.
 * - Sends the Admin Auth NFT to the user's wallet.
 * - Initializes the Group Datum (Fees, Intervals, Inactive State).
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - Initial Group Configuration.
 * @returns Effect yielding `{ tx, groupTokenSuffix }` — the signable tx plus the
 *   permanent CIP-68 group token suffix.
 */
export type CreateGroupConfig = {
  groupName: string; // displayed by wallets — goes into metadata["name"]
  // Optional free-text purpose/description (e.g. "Kiambu land-buying chama"). Stored in the
  // CIP-68 metadata["description"] of the on-chain group datum and, like the name, frozen by
  // the validator once a member joins (UpdateGroup treats metadata as a critical field). Kept
  // short — it lives in the inline datum, so longer text raises the UTxO's min-ADA and tx size.
  groupDescription?: string;
  groupDatum: GroupDatum;
  utxoToSpend: OutRef;
  /** Required when `groupDatum.creator_payment_credential` is a `Script` credential:
   *  the script whose hash must match it. Joining fees route to this credential
   *  forever (frozen at first join), so the SDK requires proof the destination is
   *  spendable — a typo'd or unspendable script hash would burn every fee. */
  creatorScript?: Script;
  /** Skips creator-credential verification (not recommended). */
  force?: boolean;
  /**
   * Deployed reference scripts. Creating a group now invokes BOTH minting policies
   * (group + treasury CreateReserve), and the two attached inline exceed the tx size
   * limit — pass refs (or register a session) for real deployments.
   */
  scriptRefs?: {
    treasury?: UTxO;
    group?: UTxO;
  };
};

export const unsignedCreateGroupTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: CreateGroupConfig,
): Effect.Effect<
  { tx: TxSignBuilder; groupTokenSuffix: string },
  DcuError,
  never
> =>
  Effect.gen(function* () {
    const {
      groupValidator,
      groupPolicyId,
      treasuryPolicyId,
      accountPolicyId,
      treasuryValidator,
      settingsUnit,
    } = protocol;
    const { groupName, groupDescription, groupDatum, utxoToSpend } = config;

    if (!groupPolicyId)
      yield* Effect.fail(
        new ValidatorNotFoundError({ validatorName: "group.mint" }),
      );

    // Creator-credential guard. The credential is the joining-fee destination and is
    // frozen once anyone joins, so a Script credential must be proven spendable
    // (creatorScript hash match) and must not be a protocol script — a protocol
    // script's own continuation outputs would satisfy the on-chain fee check, silently
    // voiding the fee.
    const creatorCred = groupDatum.creator_payment_credential;
    if (!config.force && "Script" in creatorCred) {
      const hash = creatorCred.Script[0];
      const protocolHashes = [
        groupPolicyId,
        treasuryPolicyId,
        accountPolicyId,
      ].filter(Boolean);
      if (protocolHashes.includes(hash)) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "creator_payment_credential",
            message:
              "creator credential must not be a protocol script hash — the protocol's own outputs would satisfy the joining-fee check",
          }),
        );
      }
      if (!config.creatorScript) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "creatorScript",
            message:
              "creator credential is a script; pass creatorScript proving the fee destination is spendable, or force: true",
          }),
        );
      }
      if (validatorToScriptHash(config.creatorScript) !== hash) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "creatorScript",
            message:
              "creatorScript hash does not match creator_payment_credential",
          }),
        );
      }
    }

    const address = yield* getWalletAddress(lucid);
    const groupAddress = yield* getScriptAddress(
      lucid,
      groupValidator.spendGroup,
    );

    // CIP-68 display metadata. "description" is added only when provided so a group
    // created without one keeps the exact same metadata shape as before.
    const metadata = new Map([[fromText("name"), fromText(groupName)]]);
    if (groupDescription !== undefined && groupDescription.length > 0) {
      metadata.set(fromText("description"), fromText(groupDescription));
    }

    const datum = buildGroupCip68Datum(metadata, 1n, groupDatum);

    // Resolve the full UTxO from the OutRef so we can compute CIP-68 names
    // (which require the txHash + outputIndex) and collect from it.
    const utxo = yield* resolveUtxoByOutRef(lucid, utxoToSpend);

    // Derive CIP-68 token names the same way the Aiken validator does:
    //   ref_token_name  = blake2b_256(cbor(utxoToSpend.outputRef)) with prefix_100
    //   user_token_name = blake2b_256(cbor(utxoToSpend.outputRef)) with prefix_222
    const { refTokenName, userTokenName } = yield* createCip68TokenNames(utxo);

    // Permanent CIP-68 suffix: the 28-byte hash tail shared by the ref (100) and admin
    // (222) tokens (asset name minus its label prefix) — the stable group identity.
    const groupTokenSuffix = refTokenName.slice(
      assetNameLabels.prefix100.length,
    );

    const refToken = toUnit(groupPolicyId, refTokenName);
    const userToken = toUnit(groupPolicyId, userTokenName);

    const mintingAssets: Assets = { [refToken]: 1n, [userToken]: 1n };

    // [spec Reserve]: every group is created together with its mutual reserve —
    // one ReserveState UTxO at the treasury script, identified by the reserve
    // token ("RSVE" + the group suffix) minted under the TREASURY policy in the
    // same tx (CreateReserve, one-shot). The treasury mint reads the trusted
    // group policy from the settings UTxO (reference input).
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const reserveToken = toUnit(treasuryPolicyId, reserveTokenName(refTokenName));
    const reserveDatum: TreasuryDatum = {
      ReserveState: {
        group_reference_tokenname: refTokenName,
        standin_rounds: 0n,
      },
    };
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      treasuryValidator.spendTreasury,
    );
    // On-chain requires an ENTERPRISE reserve address (stake credential = None):
    // the pot is communal, so a creator-supplied stake credential would skim its
    // staking rewards. getScriptAddress builds enterprise addresses already.
    const reserveAssets: Assets = { [reserveToken]: 1n, lovelace: 2_000_000n };
    // Outputs: 0 = group UTxO, 1 = admin (222) to wallet, 2 = reserve.
    const createReserveRedeemer = Data.to(
      {
        CreateReserve: {
          group_output_index: 0n,
          reserve_output_index: 2n,
        },
      },
      TreasuryRedeemer,
    );
    // Lock creator_bond lovelace alongside the ref token so it is held for
    // the group's lifetime and returned to the admin on deleteGroup.
    const scriptAssets: Assets =
      groupDatum.creator_bond > 0n
        ? { [refToken]: 1n, lovelace: groupDatum.creator_bond }
        : { [refToken]: 1n };
    const walletAssets: Assets = { [userToken]: 1n };

    // Constr(0, [input_index, output_index]) = GroupMintRedeemer.CreateGroup.
    // RedeemerBuilder resolves the actual sorted index of utxoToSpend at build time.
    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(new Constr(0, [inputIndices[0], 0n])),
      inputs: [utxo],
    };

    const baseTx = lucid
      .newTx()
      .collectFrom([utxo])
      .mintAssets(mintingAssets, redeemer)
      .mintAssets({ [reserveToken]: 1n }, createReserveRedeemer)
      .pay.ToContract(
        groupAddress,
        { kind: "inline", value: datum },
        scriptAssets,
      )
      .pay.ToAddress(address, walletAssets)
      .pay.ToContract(
        treasuryAddress,
        { kind: "inline", value: Data.to(reserveDatum, TreasuryDatum) },
        reserveAssets,
      )
      .readFrom([settingsUtxo]);

    // Two minting policies run in this tx; attached inline together they exceed
    // the tx size limit — prefer reference scripts when available.
    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const withGroupValidator = scriptRefs.group
      ? baseTx.readFrom([scriptRefs.group])
      : baseTx.attach.MintingPolicy(groupValidator.mintGroup);
    const withTreasuryValidator = scriptRefs.treasury
      ? withGroupValidator.readFrom([scriptRefs.treasury])
      : withGroupValidator.attach.MintingPolicy(treasuryValidator.mintTreasury);

    const tx = yield* withTreasuryValidator
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "createGroup",
              error: String(e),
            }),
        ),
      );
    return { tx, groupTokenSuffix };
  });
