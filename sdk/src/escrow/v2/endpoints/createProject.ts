import {
  Data,
  fromText,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  InsufficientUtxosError,
  TransactionBuildError,
} from "../../../core/errors.js";
import {
  getWalletAddress,
  getWalletUtxos,
  makeReturn,
  sortUtxos,
} from "../../../core/utils/index.js";
import {
  PartyRef,
  partyToCredential,
  ProjectDatum,
  ProjectMintRedeemer,
} from "../types.js";
import { projectPolicyId, projectValidator } from "../validators.js";
import { escrowStateTokenName, projectAddress } from "../utils.js";

/**
 * Creates an unsigned transaction minting a Project anchor — the passive
 * identity/metadata NFT that groups escrows (`project_id`). Freely mutable by
 * its owner; escrows bind by the opaque token name, never by UTxO reference,
 * so no project change can break an escrow.
 *
 * @param lucid - Lucid instance with the paying wallet selected.
 * @param config - CreateProjectConfig.
 * @returns Effect yielding `{ tx, projectTokenName }` — persist the name; it
 *          is the `projectId` escrows cite.
 */
export type CreateProjectConfig = {
  /** Short human-readable label, max 64 UTF-8 bytes. */
  title: string;
  /** Hex hash of the off-chain project document. */
  contentHash?: string;
  /** Owner: an address, or `{ type, hash }` (e.g. a committee multisig). Defaults to the wallet. */
  owner?: PartyRef;
};

export const unsignedCreateProjectTxProgram = (
  lucid: LucidEvolution,
  config: CreateProjectConfig,
): Effect.Effect<
  { tx: TxSignBuilder; projectTokenName: string },
  DcuError,
  never
> =>
  Effect.gen(function* () {
    const titleHex = fromText(config.title);
    if (titleHex.length > 128) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "title",
          message: "title must be at most 64 UTF-8 bytes",
        }),
      );
    }
    const walletAddress = yield* getWalletAddress(lucid);
    // Reference-script UTxOs are never seeds — spending one as the one-shot
    // seed input destroys the deployed script for every future transaction.
    const utxos = sortUtxos(yield* getWalletUtxos(lucid)).filter(
      (u) => !u.scriptRef,
    );
    const seed = utxos[0];
    if (!seed) {
      return yield* Effect.fail(
        new InsufficientUtxosError({ required: 1, available: 0 }),
      );
    }
    const projectTokenName = yield* escrowStateTokenName(seed);
    const projectUnit = projectPolicyId + projectTokenName;
    const owner = yield* partyToCredential(
      config.owner ?? walletAddress,
      "owner",
    );

    const datum: ProjectDatum = {
      title: titleHex,
      content_hash: config.contentHash ?? null,
      status: 0n,
      owner,
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            CreateProject: {
              seed_input_index: inputIndices[0],
              project_output_index: 0n,
            },
          },
          ProjectMintRedeemer,
        ),
      inputs: [seed],
    };

    const network = lucid.config().network ?? "Preprod";
    const tx = yield* lucid
      .newTx()
      .collectFrom([seed])
      .mintAssets({ [projectUnit]: 1n }, redeemer)
      .attach.MintingPolicy(projectValidator.mintProject)
      .pay.ToContract(
        projectAddress(network),
        { kind: "inline", value: Data.to(datum, ProjectDatum) },
        { lovelace: 2_000_000n, [projectUnit]: 1n },
      )
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "createProject",
              error: String(e),
            }),
        ),
      );

    return { tx, projectTokenName };
  });

export const createProject = (
  lucid: LucidEvolution,
  config: CreateProjectConfig,
) => makeReturn(unsignedCreateProjectTxProgram(lucid, config));
