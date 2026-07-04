import {
  type LucidEvolution,
  type Network,
  type UTxO,
  mintingPolicyToId,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { ReferenceScriptMismatchError } from "./errors.js";
import type { Protocol } from "./validators/constants.js";

/**
 * Reference-script UTxOs for the size-sensitive validators. When supplied, an
 * endpoint resolves the validator bytes from the on-chain UTxO via `readFrom`
 * (keeping the tx under the 16 KB limit) instead of inlining them.
 *
 * These are fully-resolved `UTxO`s (carrying `scriptRef`), as produced by the
 * admin `deployScripts` flow — not bare `OutRef`s.
 */
export type ScriptRefs = {
  treasury?: UTxO;
  group?: UTxO;
  // Treasury family stake validators (treasury split, spec 2026-07-04). Every
  // treasury endpoint attaches a 0-ADA withdrawal from its family's credential;
  // the family script rides as a reference script (or is attached inline when
  // its ref is absent).
  treasuryRounds?: UTxO;
  treasuryLifecycle?: UTxO;
  treasuryRecovery?: UTxO;
  treasuryReserve?: UTxO;
};

/** Where a resolved set of reference scripts came from (see {@link resolveScriptRefs}). */
export type ScriptRefSource = "override" | "session" | "bundled" | "inline";

// ─── Session default ─────────────────────────────────────────────────────────
// A process-wide default so an integrator can set their deployed reference scripts
// ONCE (e.g. right after `deployScripts`) instead of threading them through every
// endpoint call. Per-call config always wins over this.

let sessionRefs: ScriptRefs | undefined;

const hasRefs = (refs?: ScriptRefs): refs is ScriptRefs =>
  !!refs &&
  (!!refs.treasury ||
    !!refs.group ||
    !!refs.treasuryRounds ||
    !!refs.treasuryLifecycle ||
    !!refs.treasuryRecovery ||
    !!refs.treasuryReserve);

/**
 * Sets the session-default reference scripts used by every endpoint that takes a
 * `scriptRefs` config field, when that call doesn't pass its own. Ideal for
 * emulator/custom networks and for binding a live deployment once per session.
 *
 * @example
 * const refs = await deployScripts(protocol, lucid).unsafeRun();
 * configureReferenceScripts({ treasury: refs.treasuryUtxo, group: refs.groupUtxo });
 * // …now every joinGroup/distributePayout/… call uses them automatically.
 */
export const configureReferenceScripts = (refs: ScriptRefs): void => {
  sessionRefs = refs;
};

/** Clears any session-default reference scripts (back to inline bytecode). */
export const clearReferenceScripts = (): void => {
  sessionRefs = undefined;
};

/** Returns the current session-default reference scripts, if any. */
export const getSessionReferenceScripts = (): ScriptRefs | undefined =>
  sessionRefs;

// ─── Bundled canonical outRefs (mainnet-freeze hook) ─────────────────────────

/**
 * Canonical, package-bundled reference scripts for a network.
 *
 * INTENTIONALLY returns `undefined` for every network today. Bundling a fixed
 * on-chain UTxO ref is only safe once the validator hashes are FROZEN for a
 * mainnet release and a canonical deployment is published in lockstep with the
 * bytecode — otherwise the baked-in ref goes stale on every hash-changing patch
 * and silently produces invalid txs. Until that milestone this is a no-op hook:
 * fill it in (per network) when a canonical deployment exists.
 */
export const getBundledReferenceScripts = (
  _network: Network,
): ScriptRefs | undefined => undefined;

// ─── Resolution precedence ───────────────────────────────────────────────────

/**
 * Resolves which reference scripts an endpoint should use, most-specific first:
 *   1. `perCall`  — explicit `scriptRefs` on the call config
 *   2. session    — {@link configureReferenceScripts}
 *   3. bundled    — {@link getBundledReferenceScripts} for the network (none today)
 *   4. inline     — no refs; validator bytes are inlined
 *
 * @param perCall - the call's own `scriptRefs`, if any
 * @param network - active network, used only for the (currently no-op) bundled tier
 */
export const resolveScriptRefs = (
  perCall?: ScriptRefs,
  network?: Network,
): { source: ScriptRefSource; refs: ScriptRefs } => {
  if (hasRefs(perCall)) return { source: "override", refs: perCall };
  if (hasRefs(sessionRefs)) return { source: "session", refs: sessionRefs };
  const bundled = network ? getBundledReferenceScripts(network) : undefined;
  if (hasRefs(bundled)) return { source: "bundled", refs: bundled };
  return { source: "inline", refs: {} };
};

/**
 * Convenience for endpoints: the effective reference scripts for a call, applying
 * {@link resolveScriptRefs} precedence. Returns an empty object (inline) when none
 * are configured, so existing inline behaviour is unchanged when nothing is set.
 */
export const effectiveScriptRefs = (perCall?: ScriptRefs): ScriptRefs =>
  resolveScriptRefs(perCall).refs;

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Verifies that each supplied reference-script UTxO actually carries a `scriptRef`
 * whose hash matches the deployment's compiled validator hash. Turns the otherwise
 * cryptic on-chain "script hash mismatch" ledger failure into a typed, early error.
 *
 * Only checks the refs that are present; absent refs (inline path) are fine.
 *
 * @throws ReferenceScriptMismatchError when a ref's script hash diverges, or when a
 *   supplied UTxO carries no script reference at all.
 */
export const verifyReferenceScripts = (
  protocol: Protocol,
  refs: ScriptRefs,
): Effect.Effect<void, ReferenceScriptMismatchError> =>
  Effect.gen(function* () {
    const checks: Array<
      [
        (
          | "treasury"
          | "group"
          | "treasuryRounds"
          | "treasuryLifecycle"
          | "treasuryRecovery"
          | "treasuryReserve"
        ),
        UTxO | undefined,
        string,
      ]
    > = [
      ["treasury", refs.treasury, protocol.treasuryPolicyId],
      ["group", refs.group, protocol.groupPolicyId],
      [
        "treasuryRounds",
        refs.treasuryRounds,
        protocol.treasuryStakeHashes.rounds,
      ],
      [
        "treasuryLifecycle",
        refs.treasuryLifecycle,
        protocol.treasuryStakeHashes.lifecycle,
      ],
      [
        "treasuryRecovery",
        refs.treasuryRecovery,
        protocol.treasuryStakeHashes.recovery,
      ],
      [
        "treasuryReserve",
        refs.treasuryReserve,
        protocol.treasuryStakeHashes.reserve,
      ],
    ];

    for (const [validator, utxo, expectedHash] of checks) {
      if (!utxo) continue;
      if (!utxo.scriptRef) {
        return yield* Effect.fail(
          new ReferenceScriptMismatchError({
            validator,
            expectedHash,
            actualHash: "none",
            reason: "reference UTxO carries no script",
          }),
        );
      }
      const actualHash = mintingPolicyToId(utxo.scriptRef);
      if (actualHash !== expectedHash) {
        return yield* Effect.fail(
          new ReferenceScriptMismatchError({
            validator,
            expectedHash,
            actualHash,
            reason: "stale or wrong reference script (hash mismatch)",
          }),
        );
      }
    }
  });

/**
 * Reports which reference scripts an endpoint would use and from where, and (when a
 * `protocol` is given) whether the resolved refs verify against the compiled hashes.
 * Purely diagnostic — does not build a tx.
 */
export const resolveReferenceScripts = (
  lucid: LucidEvolution,
  options: { perCall?: ScriptRefs; protocol?: Protocol } = {},
): Effect.Effect<
  { source: ScriptRefSource; refs: ScriptRefs; verified: boolean },
  ReferenceScriptMismatchError
> =>
  Effect.gen(function* () {
    const network = lucid.config().network;
    const { source, refs } = resolveScriptRefs(options.perCall, network);
    if (options.protocol && hasRefs(refs)) {
      yield* verifyReferenceScripts(options.protocol, refs);
      return { source, refs, verified: true };
    }
    return { source, refs, verified: false };
  });
