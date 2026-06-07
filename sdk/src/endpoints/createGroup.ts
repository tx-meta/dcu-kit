import {
  Data,
  TxSignBuilder,
  LucidEvolution,
  OutRef,
  RedeemerBuilder,
  Constr,
  Assets,
  toUnit,
  fromText,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum } from "../core/types.js";
import {
  buildGroupCip68Datum,
  getScriptAddress,
  getWalletAddress,
  createCip68TokenNames,
  resolveUtxoByOutRef,
  assetNameLabels,
} from "../core/utils/index.js";
import {
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
    const { groupValidator, groupPolicyId } = protocol;
    const { groupName, groupDescription, groupDatum, utxoToSpend } = config;

    if (!groupPolicyId)
      yield* Effect.fail(
        new ValidatorNotFoundError({ validatorName: "group.mint" }),
      );

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

    const tx = yield* lucid
      .newTx()
      .collectFrom([utxo])
      .mintAssets(mintingAssets, redeemer)
      .pay.ToContract(
        groupAddress,
        { kind: "inline", value: datum },
        scriptAssets,
      )
      .pay.ToAddress(address, walletAssets)
      .attach.MintingPolicy(groupValidator.mintGroup)
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
