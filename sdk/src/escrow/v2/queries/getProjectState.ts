import { LucidEvolution, toText } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError } from "../../../core/errors.js";
import { makeReturn } from "../../../core/utils/index.js";
import { resolveProject } from "../utils.js";

/**
 * Reads a live Project anchor's state. Read-only.
 *
 * @param lucid - Lucid instance (no wallet needed).
 * @param config - GetProjectStateConfig.
 * @returns Effect yielding ProjectState.
 */
export type GetProjectStateConfig = {
  /** The project's permanent identity (returned by createProject). */
  projectTokenName: string;
};

export type ProjectState = {
  title: string;
  contentHash: string | null;
  status: "Active" | "Closed";
  owner: { type: "Key" | "Script"; hash: string };
};

export const getProjectStateProgram = (
  lucid: LucidEvolution,
  config: GetProjectStateConfig,
): Effect.Effect<ProjectState, DcuError, never> =>
  Effect.gen(function* () {
    const { datum } = yield* resolveProject(lucid, config.projectTokenName);
    return {
      title: toText(datum.title),
      contentHash: datum.content_hash,
      status: datum.status === 0n ? ("Active" as const) : ("Closed" as const),
      owner:
        "VerificationKey" in datum.owner
          ? { type: "Key" as const, hash: datum.owner.VerificationKey[0] }
          : { type: "Script" as const, hash: datum.owner.Script[0] },
    };
  });

export const getProjectState = (
  lucid: LucidEvolution,
  config: GetProjectStateConfig,
) => makeReturn(getProjectStateProgram(lucid, config));
