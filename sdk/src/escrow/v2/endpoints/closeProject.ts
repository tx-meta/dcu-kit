import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../../core/errors.js";
import { makeReturn } from "../../../core/utils/index.js";
import { ProjectMintRedeemer, ProjectSpendRedeemer } from "../types.js";
import { projectPolicyId, projectValidator } from "../validators.js";
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
  /** The project's permanent identity (returned by createProject). */
  projectTokenName: string;
  /** Required when the owner credential is a script hash. */
  ownerWitness?: PartyWitness;
};

export const unsignedCloseProjectTxProgram = (
  lucid: LucidEvolution,
  config: CloseProjectConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
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

    const baseTx = lucid
      .newTx()
      .collectFrom([projectUtxo], redeemer)
      .attach.SpendingValidator(projectValidator.spendProject)
      .mintAssets(
        { [projectUnit]: -1n },
        Data.to("BurnProject", ProjectMintRedeemer),
      )
      .attach.MintingPolicy(projectValidator.mintProject);

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
