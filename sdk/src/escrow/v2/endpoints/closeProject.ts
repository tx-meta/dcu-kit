import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../../core/errors.js";
import {
  makeReturn,
  attachTxMessage,
  type TxMessage,
} from "../../../core/utils/index.js";
import { ProjectMintRedeemer, ProjectSpendRedeemer } from "../types.js";
import { projectPolicyId, projectValidator } from "../validators.js";
import {
  effectiveEscrowV2ScriptRefs,
  EscrowV2ScriptRefs,
  verifyEscrowV2ScriptRefs,
  witnessEscrowV2Script,
} from "../scriptRefs.js";
import { applyPartyWitness, PartyWitness, resolveProject } from "../utils.js";

/**
 * Creates an unsigned transaction burning a Project anchor (owner-authorized).
 * Escrows citing the project keep working — the id is opaque and never
 * dereferenced on-chain. Prefer `updateProject` with status "Closed" when the
 * on-chain history should stay visible.
 *
 * @param lucid - Lucid instance with the owner's wallet selected.
 * @param config - CloseProjectConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type CloseProjectConfig = {
  /**
   * Reference-script UTxOs for the escrow v2 validators. Supplying the
   * escrow ref keeps its 11.4 KB out of the transaction body. Falls back
   * to the session default set by `configureEscrowV2ReferenceScripts`,
   * then to inlining the script.
   */
  scriptRefs?: EscrowV2ScriptRefs;
  /** The project's permanent identity (returned by createProject). */
  projectTokenName: string;
  /** Required when the owner credential is a script hash. */
  ownerWitness?: PartyWitness;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

export const unsignedCloseProjectTxProgram = (
  lucid: LucidEvolution,
  config: CloseProjectConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const scriptRefs = effectiveEscrowV2ScriptRefs(config.scriptRefs);
    yield* verifyEscrowV2ScriptRefs(scriptRefs);
    const { utxo: projectUtxo, datum } = yield* resolveProject(
      lucid,
      config.projectTokenName,
    );
    const projectUnit = projectPolicyId + config.projectTokenName;

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { CloseProject: { project_input_index: inputIndices[0] } },
          ProjectSpendRedeemer,
        ),
      inputs: [projectUtxo],
    };

    const baseTx = witnessEscrowV2Script(
      yield* attachTxMessage(lucid.newTx(), config.message),
      "project",
      scriptRefs,
      ["spend", "mint"],
    )
      .collectFrom([projectUtxo], redeemer)
      .mintAssets(
        { [projectUnit]: -1n },
        Data.to("BurnProject", ProjectMintRedeemer),
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
            operation: "closeProject",
            error: String(e),
          }),
      ),
    );
  });

export const closeProject = (
  lucid: LucidEvolution,
  config: CloseProjectConfig,
) => makeReturn(unsignedCloseProjectTxProgram(lucid, config));
