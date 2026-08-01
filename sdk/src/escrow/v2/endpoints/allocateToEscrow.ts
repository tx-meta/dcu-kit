import {
  Assets,
  credentialToAddress,
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  LucidError,
  TransactionBuildError,
} from "../../../core/errors.js";
import {
  makeReturn,
  patchInlineDatum,
  attachTxMessage,
  type TxMessage,
} from "../../../core/utils/index.js";
import {
  EscrowDatumV2,
  EscrowV2MintRedeemer,
  EscrowV2SpendRedeemer,
  PoolSpendRedeemer,
  VaultDatum,
} from "../types.js";
import {
  escrowV2PolicyId,
  escrowV2Validator,
  poolVaultValidator,
} from "../validators.js";
import {
  effectiveEscrowV2ScriptRefs,
  EscrowV2ScriptRefs,
  verifyEscrowV2ScriptRefs,
  witnessEscrowV2Script,
} from "../scriptRefs.js";
import {
  applyPartyWitness,
  escrowV2Address,
  PartyWitness,
  poolVaultAddress,
  resolveEscrowV2,
  resolvePool,
} from "../utils.js";
import { CreateEscrowV2Config, prepareEscrowCreate } from "./createEscrow.js";

/**
 * Creates an unsigned transaction allocating ONE pool deposit — the quorum's
 * ratified decision made binding. Two modes:
 *
 * - `newEscrow`: the deposit seeds a brand-new milestone escrow (created in
 *   the same transaction; the escrow's funder defaults to the quorum's
 *   address, so reclaims flow back under quorum control).
 * - `existingStateTokenName`: the whole deposit tops up an existing
 *   PerMilestone escrow whose funder is the quorum.
 *
 * The vault enforces that the allocated value arrives at the pool's escrow
 * target — pool money can only ever become milestone-disciplined funding.
 *
 * Note: the default escrow funder (the quorum's enterprise address) has no
 * stake credential — frontends indexing by base address must index by payment
 * credential instead, or pass `escrowFunderAddress` explicitly.
 *
 * @param lucid - Lucid instance (any wallet; the quorum must sign).
 * @param config - AllocateToEscrowConfig.
 * @returns Effect yielding `{ tx, stateTokenName }` (the new or topped-up escrow).
 */
export type AllocateToEscrowConfig = {
  /** The pool's permanent identity (returned by createPool). */
  poolTokenName: string;
  /** Seed a new escrow from the deposit (mutually exclusive with existing…). */
  newEscrow?: Omit<CreateEscrowV2Config, "funderAddress">;
  /** …or top up this existing quorum-funded PerMilestone escrow. */
  existingStateTokenName?: string;
  /** Overrides the escrow's funder/refund address (default: quorum address). */
  escrowFunderAddress?: string;
  /** Required when the quorum credential is a script hash (multisig). */
  quorumWitness?: PartyWitness;
  /**
   * Reference-script UTxOs for the escrow v2 validators. STRONGLY recommended
   * here: this transaction witnesses both the pool vault and the escrow
   * scripts, and inlining the 11.4 KB escrow script exceeds the 16 KB
   * transaction ceiling for most schedules. Falls back to the session default
   * set by `configureEscrowV2ReferenceScripts`.
   */
  scriptRefs?: EscrowV2ScriptRefs;
  /**
   * @deprecated Use `scriptRefs: { escrow }`. Still honoured, and it wins over
   * `scriptRefs.escrow` when both are supplied.
   */
  escrowScriptRef?: UTxO;
  /** Clock override (POSIX ms) — pass `emulator.now()` in emulator tests. */
  currentTime?: bigint;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

const findDeposit = (
  lucid: LucidEvolution,
  poolTokenName: string,
  vaultAddress: string,
): Effect.Effect<{ utxo: UTxO; raw: string }, DcuError, never> =>
  Effect.gen(function* () {
    const utxos: UTxO[] = yield* Effect.tryPromise({
      try: () => lucid.utxosAt(vaultAddress),
      catch: (e) =>
        new LucidError({ message: `utxosAt(poolVault) failed: ${String(e)}` }),
    });
    let best: { utxo: UTxO; raw: string; lovelace: bigint } | undefined;
    for (const rawUtxo of utxos) {
      const utxo = patchInlineDatum(rawUtxo);
      if (!utxo.datum) continue;
      let parsed: VaultDatum;
      try {
        parsed = Data.from(utxo.datum, VaultDatum);
      } catch {
        continue;
      }
      if (typeof parsed === "string" || !("PoolDeposit" in parsed)) continue;
      if (parsed.PoolDeposit.pool_id !== poolTokenName) continue;
      const lovelace = utxo.assets.lovelace ?? 0n;
      if (!best || lovelace > best.lovelace) {
        best = { utxo, raw: utxo.datum, lovelace };
      }
    }
    if (!best) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "poolTokenName",
          message: "the pool has no unallocated deposits",
        }),
      );
    }
    return { utxo: best.utxo, raw: best.raw };
  });

// Reference inputs are serialized as a SORTED set (by tx hash bytes, then
// output index), so the pool anchor's position among them depends on how its
// outref sorts against the escrow script-ref UTxO — never hardcode it.
const sortedRefIndexOf = (target: UTxO, refs: UTxO[]): bigint => {
  const key = (u: UTxO) =>
    `${u.txHash.toLowerCase()}#${u.outputIndex.toString().padStart(10, "0")}`;
  const sorted = [...refs].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return BigInt(sorted.findIndex((u) => key(u) === key(target)));
};

export const unsignedAllocateToEscrowTxProgram = (
  lucid: LucidEvolution,
  config: AllocateToEscrowConfig,
): Effect.Effect<
  { tx: TxSignBuilder; stateTokenName: string },
  DcuError,
  never
> =>
  Effect.gen(function* () {
    const resolved = effectiveEscrowV2ScriptRefs(config.scriptRefs);
    const scriptRefs: EscrowV2ScriptRefs = config.escrowScriptRef
      ? { ...resolved, escrow: config.escrowScriptRef }
      : resolved;
    yield* verifyEscrowV2ScriptRefs(scriptRefs);
    const network = lucid.config().network ?? "Preprod";
    const { utxo: poolUtxo, pool } = yield* resolvePool(
      lucid,
      config.poolTokenName,
    );
    if (pool.status !== 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "poolTokenName",
          message: "the pool is closed — no further allocations",
        }),
      );
    }
    const now = config.currentTime ?? BigInt(Date.now());
    if (pool.funding_deadline !== null && now > pool.funding_deadline) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "poolTokenName",
          message: `the funding deadline (${pool.funding_deadline}) has passed`,
        }),
      );
    }
    if (pool.escrow_target !== escrowV2PolicyId) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "poolTokenName",
          message:
            "this SDK build only allocates to the escrow v2 generation the pool must target",
        }),
      );
    }

    const deposit = yield* findDeposit(
      lucid,
      config.poolTokenName,
      poolVaultAddress(network),
    );
    // The ledger presents reference inputs to scripts as a SORTED set, so the
    // pool's index must be computed against EVERY ref this tx reads, not just
    // the pool state UTxO.
    const refInputs = [
      poolUtxo,
      ...(scriptRefs.pool ? [scriptRefs.pool] : []),
      ...(scriptRefs.escrow ? [scriptRefs.escrow] : []),
    ];
    const poolRefIndex = sortedRefIndexOf(poolUtxo, refInputs);
    const quorumAddress =
      "VerificationKey" in pool.quorum
        ? credentialToAddress(network, {
            type: "Key",
            hash: pool.quorum.VerificationKey[0],
          })
        : credentialToAddress(network, {
            type: "Script",
            hash: pool.quorum.Script[0],
          });

    if (config.newEscrow) {
      const prepared = yield* prepareEscrowCreate(
        { ...config.newEscrow, currentTime: now },
        deposit.utxo,
        config.escrowFunderAddress ?? quorumAddress,
      );
      const stateUnit = escrowV2PolicyId + prepared.stateTokenName;
      const lockedLovelace = prepared.lockedAssets.lovelace ?? 0n;
      const depositLovelace = deposit.utxo.assets.lovelace ?? 0n;
      if (depositLovelace < lockedLovelace) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "newEscrow",
            message: `the largest deposit (${depositLovelace}) does not cover the escrow lock (${lockedLovelace}); allocate a smaller schedule or top up the pool`,
          }),
        );
      }
      const remainder = depositLovelace - lockedLovelace;
      const hasContinuation = remainder > 2_000_000n;
      const spendRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (ix: bigint[]) =>
          Data.to(
            {
              AllocateToEscrow: {
                deposit_input_index: ix[0],
                pool_ref_index: poolRefIndex,
                escrow_output_index: 0n,
                escrow_input_index: 99n,
                continuation_index: hasContinuation ? 1n : 99n,
              },
            },
            PoolSpendRedeemer,
          ),
        inputs: [deposit.utxo],
      };
      const mintRedeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (ix: bigint[]) =>
          Data.to(
            {
              CreateEscrowV2: {
                seed_input_index: ix[0],
                escrow_output_index: 0n,
              },
            },
            EscrowV2MintRedeemer,
          ),
        inputs: [deposit.utxo],
      };
      const deadline =
        pool.funding_deadline === null
          ? prepared.firstCure - 1_000n
          : pool.funding_deadline < prepared.firstCure - 1_000n
            ? pool.funding_deadline
            : prepared.firstCure - 1_000n;
      const validTo = Number(
        now + 1_200_000n < deadline ? now + 1_200_000n : deadline,
      );

      let tx = witnessEscrowV2Script(
        (yield* attachTxMessage(lucid.newTx(), config.message))
          .readFrom([poolUtxo])
          .collectFrom([deposit.utxo], spendRedeemer),
        "pool",
        scriptRefs,
        ["spend"],
      ).mintAssets({ [stateUnit]: 1n }, mintRedeemer);
      tx = witnessEscrowV2Script(tx, "escrow", scriptRefs, ["mint"]);
      tx = tx.pay
        .ToContract(
          escrowV2Address(network),
          { kind: "inline", value: Data.to(prepared.datum, EscrowDatumV2) },
          { ...prepared.lockedAssets, [stateUnit]: 1n },
        )
        .validTo(validTo);
      if (hasContinuation) {
        tx = tx.pay.ToContract(
          deposit.utxo.address,
          { kind: "inline", value: deposit.raw },
          { lovelace: remainder },
        );
      }
      const withWitness = yield* applyPartyWitness(
        lucid,
        tx,
        pool.quorum,
        config.quorumWitness,
        "quorum",
      );
      const built = yield* withWitness.completeProgram().pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "allocateToEscrow(new)",
              error: String(e),
            }),
        ),
      );
      return { tx: built, stateTokenName: prepared.stateTokenName };
    }

    if (!config.existingStateTokenName) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "newEscrow",
          message: "pass either newEscrow or existingStateTokenName",
        }),
      );
    }
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.existingStateTokenName,
    );
    if (datum.funding_mode !== "PerMilestone") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "existingStateTokenName",
          message: "only PerMilestone escrows accept contributions",
        }),
      );
    }
    const depositLovelace = deposit.utxo.assets.lovelace ?? 0n;
    const continuationAssets: Assets = {
      ...escrowUtxo.assets,
      lovelace: (escrowUtxo.assets.lovelace ?? 0n) + depositLovelace,
    };
    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (ix: bigint[]) =>
        Data.to(
          {
            AllocateToEscrow: {
              deposit_input_index: ix[0],
              pool_ref_index: poolRefIndex,
              escrow_output_index: 0n,
              escrow_input_index: ix[1],
              continuation_index: 99n,
            },
          },
          PoolSpendRedeemer,
        ),
      inputs: [deposit.utxo, escrowUtxo],
    };
    const contributeRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (ix: bigint[]) =>
        Data.to(
          {
            Contribute: {
              escrow_input_index: ix[1],
              continuation_index: 0n,
            },
          },
          EscrowV2SpendRedeemer,
        ),
      inputs: [deposit.utxo, escrowUtxo],
    };
    let baseTx = witnessEscrowV2Script(
      (yield* attachTxMessage(lucid.newTx(), config.message))
        .readFrom([poolUtxo])
        .collectFrom([deposit.utxo], spendRedeemer)
        .collectFrom([escrowUtxo], contributeRedeemer),
      "pool",
      scriptRefs,
      ["spend"],
    );
    baseTx = witnessEscrowV2Script(baseTx, "escrow", scriptRefs, ["spend"]);
    baseTx = baseTx.pay
      .ToContract(
        escrowUtxo.address,
        { kind: "inline", value: Data.to(datum, EscrowDatumV2) },
        continuationAssets,
      )
      .validTo(
        Number(
          pool.funding_deadline === null
            ? now + 1_200_000n
            : pool.funding_deadline < now + 1_200_000n
              ? pool.funding_deadline
              : now + 1_200_000n,
        ),
      );
    // One witness covers both scripts when the escrow's funder IS the quorum.
    const withWitness = yield* applyPartyWitness(
      lucid,
      baseTx,
      pool.quorum,
      config.quorumWitness,
      "quorum",
    );
    const withFunder =
      JSON.stringify(datum.funder.payment_credential) ===
      JSON.stringify(pool.quorum)
        ? withWitness
        : yield* applyPartyWitness(
            lucid,
            withWitness,
            datum.funder.payment_credential,
            config.quorumWitness,
            "funder",
          );
    const built = yield* withFunder.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "allocateToEscrow(existing)",
            error: String(e),
          }),
      ),
    );
    return { tx: built, stateTokenName: config.existingStateTokenName };
  });

export const allocateToEscrow = (
  lucid: LucidEvolution,
  config: AllocateToEscrowConfig,
) => makeReturn(unsignedAllocateToEscrowTxProgram(lucid, config));
