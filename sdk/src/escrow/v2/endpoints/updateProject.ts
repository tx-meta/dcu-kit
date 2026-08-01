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
  TransactionBuildError,
} from "../../../core/errors.js";
import {
  makeReturn,
  attachTxMessage,
  type TxMessage,
} from "../../../core/utils/index.js";
import {
  PartyRef,
  partyToCredential,
  ProjectDatum,
  ProjectSpendRedeemer,
} from "../types.js";
import { projectValidator } from "../validators.js";
import {
  effectiveEscrowV2ScriptRefs,
  EscrowV2ScriptRefs,
  verifyEscrowV2ScriptRefs,
  witnessEscrowV2Script,
} from "../scriptRefs.js";
import { applyPartyWitness, PartyWitness, resolveProject } from "../utils.js";

/**
 * Creates an unsigned transaction updating a Project anchor: title, terms
 * hash, status (Active/Closed), and owner are all freely mutable — by the
 * owner only. Escrows citing the project are unaffected by any update.
 *
 * @param lucid - Lucid instance with the owner's wallet selected.
 * @param config - UpdateProjectConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type UpdateProjectConfig = {
  /**
   * Reference-script UTxOs for the escrow v2 validators. Supplying the
   * escrow ref keeps its 11.4 KB out of the transaction body. Falls back
   * to the session default set by `configureEscrowV2ReferenceScripts`,
   * then to inlining the script.
   */
  scriptRefs?: EscrowV2ScriptRefs;
  /** The project's permanent identity (returned by createProject). */
  projectTokenName: string;
  title?: string;
  contentHash?: string | null;
  status?: "Active" | "Closed";
  /** Rotate ownership (address or credential). */
  newOwner?: PartyRef;
  /** Required when the owner credential is a script hash. */
  ownerWitness?: PartyWitness;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

export const unsignedUpdateProjectTxProgram = (
  lucid: LucidEvolution,
  config: UpdateProjectConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const scriptRefs = effectiveEscrowV2ScriptRefs(config.scriptRefs);
    yield* verifyEscrowV2ScriptRefs(scriptRefs);
    const { utxo: projectUtxo, datum } = yield* resolveProject(
      lucid,
      config.projectTokenName,
    );
    const titleHex =
      config.title === undefined ? datum.title : fromText(config.title);
    if (titleHex.length > 128) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "title",
          message: "title must be at most 64 UTF-8 bytes",
        }),
      );
    }
    const owner = config.newOwner
      ? yield* partyToCredential(config.newOwner, "newOwner")
      : datum.owner;

    const updatedDatum: ProjectDatum = {
      title: titleHex,
      content_hash:
        config.contentHash === undefined
          ? datum.content_hash
          : config.contentHash,
      status:
        config.status === undefined
          ? datum.status
          : config.status === "Active"
            ? 0n
            : 1n,
      owner,
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            UpdateProject: {
              project_input_index: inputIndices[0],
              continuation_index: 0n,
            },
          },
          ProjectSpendRedeemer,
        ),
      inputs: [projectUtxo],
    };

    const baseTx = witnessEscrowV2Script(
      yield* attachTxMessage(lucid.newTx(), config.message),
      "project",
      scriptRefs,
      ["spend"],
    )
      .collectFrom([projectUtxo], redeemer)
      .pay.ToContract(
        projectUtxo.address,
        { kind: "inline", value: Data.to(updatedDatum, ProjectDatum) },
        projectUtxo.assets,
      );

    const withWitness = yield* applyPartyWitness(
      lucid,
      baseTx,
      datum.owner,
      config.ownerWitness,
      "owner",
    );

    return yield* withWitness.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "updateProject",
            error: String(e),
          }),
      ),
    );
  });

export const updateProject = (
  lucid: LucidEvolution,
  config: UpdateProjectConfig,
) => makeReturn(unsignedUpdateProjectTxProgram(lucid, config));
