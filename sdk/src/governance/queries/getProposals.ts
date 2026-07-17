import { LucidEvolution, Network, UTxO } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { LucidError } from "../../core/errors.js";
import {
  getUtxosAt,
  parseSafeDatum,
  patchInlineDatum,
} from "../../core/utils/index.js";
import {
  GovernanceDatum,
  GovernanceDatumSchema,
  ProposalFields,
} from "../types.js";
import { GovernanceInstance } from "../validators.js";
import { dispatcherAddress } from "../utils.js";

export type ProposalView = {
  proposalId: string;
  proposal: ProposalFields;
  utxo: UTxO;
};

/**
 * Lists all live proposals of an instance (scan of the dispatcher address).
 * The anchor UTxO is skipped — only Proposal-variant datums are returned.
 */
export const getProposalsProgram = (
  lucid: LucidEvolution,
  instance: GovernanceInstance,
): Effect.Effect<ProposalView[], LucidError, never> =>
  Effect.gen(function* () {
    const network: Network = lucid.config().network ?? "Preprod";
    const utxos = yield* getUtxosAt(
      lucid,
      dispatcherAddress(network, instance),
    );
    const proposals: ProposalView[] = [];
    for (const raw of utxos) {
      const utxo = patchInlineDatum(raw);
      // Only UTxOs holding a proposal NFT of this instance's dispatcher policy.
      const hasGovToken = Object.keys(utxo.assets).some((k) =>
        k.startsWith(instance.govPolicy),
      );
      if (!hasGovToken || !utxo.datum) continue;
      const parsed = yield* parseSafeDatum(
        utxo.datum,
        GovernanceDatumSchema,
      ).pipe(Effect.catchAll(() => Effect.succeed(null)));
      const datum = parsed as unknown as GovernanceDatum | null;
      if (!datum || typeof datum === "string" || !("Proposal" in datum))
        continue;
      proposals.push({
        proposalId: datum.Proposal.proposal_id,
        proposal: datum.Proposal,
        utxo,
      });
    }
    return proposals;
  });

export const getProposals = (
  lucid: LucidEvolution,
  instance: GovernanceInstance,
) => Effect.runPromise(getProposalsProgram(lucid, instance));
