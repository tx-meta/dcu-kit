import { LucidEvolution } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  LucidError,
  UtxoNotFoundError,
} from "../../core/errors.js";
import { GovernanceAnchorFields } from "../types.js";
import { GovernanceInstance } from "../validators.js";
import { resolveAnchor } from "../utils.js";

/** Reads a governance instance's parsed charter (published hashes, config). */
export const getGovernanceStateProgram = (
  lucid: LucidEvolution,
  instance: GovernanceInstance,
): Effect.Effect<
  GovernanceAnchorFields,
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const { anchor } = yield* resolveAnchor(lucid, instance);
    return anchor;
  });

export const getGovernanceState = (
  lucid: LucidEvolution,
  instance: GovernanceInstance,
) => Effect.runPromise(getGovernanceStateProgram(lucid, instance));
