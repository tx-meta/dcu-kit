import { LucidEvolution, toText, UTxO } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, LucidError } from "../../../core/errors.js";
import { makeReturn, patchInlineDatum } from "../../../core/utils/index.js";
import { EscrowDatumV2 } from "../types.js";
import { escrowV2PolicyId } from "../validators.js";
import { escrowV2Address } from "../utils.js";

/**
 * Lists all LIVE v2 escrows citing a project — the project dashboard /
 * cap-table read (each escrow's datum is one funding row). Scans the escrow
 * script address and filters by `project_id`; on large-scale deployments an
 * indexer keyed by project id is the faster equivalent.
 *
 * @param lucid - Lucid instance (no wallet needed).
 * @param config - GetProjectEscrowsConfig.
 * @returns Effect yielding one summary per escrow.
 */
export type GetProjectEscrowsConfig = {
  /** The project token name escrows cite as `projectId`. */
  projectId: string;
};

export type ProjectEscrowSummary = {
  /** The escrow's permanent identity — feed to getEscrowState for detail. */
  stateTokenName: string;
  title: string;
  releasedCount: number;
  totalMilestones: number;
  /** Escrow-asset balance currently locked. */
  lockedBalance: bigint;
};

export const getProjectEscrowsProgram = (
  lucid: LucidEvolution,
  config: GetProjectEscrowsConfig,
): Effect.Effect<ProjectEscrowSummary[], DcuError, never> =>
  Effect.gen(function* () {
    const network = lucid.config().network ?? "Preprod";
    const utxos: UTxO[] = yield* Effect.tryPromise({
      try: () => lucid.utxosAt(escrowV2Address(network)),
      catch: (e) =>
        new LucidError({
          message: `utxosAt(escrowV2Address) failed: ${String(e)}`,
        }),
    });

    const summaries: ProjectEscrowSummary[] = [];
    for (const raw of utxos) {
      const utxo = patchInlineDatum(raw);
      if (!utxo.datum) continue;
      let datum: EscrowDatumV2;
      try {
        datum = Data.from(utxo.datum, EscrowDatumV2);
      } catch {
        continue; // foreign or malformed UTxO at the script address
      }
      if (datum.project_id !== config.projectId) continue;
      const stateTokenName = Object.keys(utxo.assets)
        .find((unit) => unit.startsWith(escrowV2PolicyId))
        ?.slice(escrowV2PolicyId.length);
      if (!stateTokenName) continue;
      const assetUnit =
        datum.asset_policy === ""
          ? "lovelace"
          : datum.asset_policy + datum.asset_name;
      summaries.push({
        stateTokenName,
        title: toText(datum.title),
        releasedCount: Number(datum.released_count),
        totalMilestones: datum.milestones.length,
        lockedBalance: utxo.assets[assetUnit] ?? 0n,
      });
    }
    return summaries;
  });

export const getProjectEscrows = (
  lucid: LucidEvolution,
  config: GetProjectEscrowsConfig,
) => makeReturn(getProjectEscrowsProgram(lucid, config));
