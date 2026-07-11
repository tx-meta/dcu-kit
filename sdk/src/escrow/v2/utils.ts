import {
  LucidEvolution,
  Network,
  UTxO,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  LucidError,
  UtxoNotFoundError,
} from "../../core/errors.js";
import {
  parseSafeDatum,
  patchInlineDatum,
  resolveUtxoByUnit,
} from "../../core/utils/index.js";
import { EscrowDatumV2, EscrowDatumV2Schema, ProjectDatum, ProjectDatumSchema } from "./types.js";
import {
  escrowV2PolicyId,
  escrowV2Validator,
  projectPolicyId,
  projectValidator,
} from "./validators.js";

// The state-token derivation and script-party witness pattern are unchanged
// from v1 — reuse, don't duplicate.
export { escrowStateTokenName, applyPartyWitness } from "../utils.js";
export type { PartyWitness } from "../utils.js";

/** SDK default grace: 14 days. Covers coordination lag; amendments carry real delays. */
export const DEFAULT_GRACE_MS = 1_209_600_000n;

/** SDK default dispute window: 7 days for the arbiter to act. */
export const DEFAULT_DISPUTE_WINDOW_MS = 604_800_000n;

/** Lovelace buffer locked at create (shared protocol convention with v1). */
export const MIN_ADA_BUFFER = 2_000_000n;

/** The v2 escrow script address for a network. */
export const escrowV2Address = (network: Network): string =>
  validatorToAddress(network, escrowV2Validator.spendEscrow);

/** The project script address for a network. */
export const projectAddress = (network: Network): string =>
  validatorToAddress(network, projectValidator.spendProject);

/** Resolves a live v2 escrow by its state-token name and parses its datum. */
export const resolveEscrowV2 = (
  lucid: LucidEvolution,
  stateTokenName: string,
): Effect.Effect<
  { utxo: UTxO; datum: EscrowDatumV2 },
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const unit = escrowV2PolicyId + stateTokenName;
    const utxoRaw = yield* resolveUtxoByUnit(lucid, unit);
    const utxo = patchInlineDatum(utxoRaw);
    const datum = (yield* parseSafeDatum(utxo.datum, EscrowDatumV2Schema).pipe(
      Effect.mapError(
        (e) =>
          new ConfigurationError({
            configKey: "stateTokenName",
            message: `UTxO holding ${unit} has no valid v2 escrow datum: ${String(e)}`,
          }),
      ),
    )) as unknown as EscrowDatumV2;
    return { utxo, datum };
  });

/** Resolves a live project by its token name and parses its datum. */
export const resolveProject = (
  lucid: LucidEvolution,
  projectTokenName: string,
): Effect.Effect<
  { utxo: UTxO; datum: ProjectDatum },
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const unit = projectPolicyId + projectTokenName;
    const utxoRaw = yield* resolveUtxoByUnit(lucid, unit);
    const utxo = patchInlineDatum(utxoRaw);
    const datum = (yield* parseSafeDatum(utxo.datum, ProjectDatumSchema).pipe(
      Effect.mapError(
        (e) =>
          new ConfigurationError({
            configKey: "projectTokenName",
            message: `UTxO holding ${unit} has no valid project datum: ${String(e)}`,
          }),
      ),
    )) as unknown as ProjectDatum;
    return { utxo, datum };
  });

/** The escrowed asset's Lucid unit ("lovelace" for ADA). */
export const escrowV2AssetUnit = (datum: EscrowDatumV2): string =>
  datum.asset_policy === ""
    ? "lovelace"
    : datum.asset_policy + datum.asset_name;

/** The current milestone's cure boundary — deadline + grace, dispute-extended. */
export const cureBoundary = (datum: EscrowDatumV2): bigint => {
  const current = datum.milestones[Number(datum.released_count)];
  if (current === undefined) return 0n;
  const disputed =
    datum.dispute !== null &&
    datum.dispute.milestone === datum.released_count;
  return (
    current.deadline + datum.grace + (disputed ? datum.dispute_window : 0n)
  );
};

/** True while a dispute on the CURRENT milestone still freezes the fund paths. */
export const disputeFrozen = (datum: EscrowDatumV2, now: bigint): boolean =>
  datum.dispute !== null &&
  datum.dispute.milestone === datum.released_count &&
  now <= datum.dispute.until;
