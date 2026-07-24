import {
  Assets,
  Constr,
  Data,
  fromText,
  LucidEvolution,
  OutRef,
  RedeemerBuilder,
  toUnit,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { Data as EffectData } from "effect";
import {
  AccountDatum,
  AccountRedeemer,
  GroupDatum,
  GroupSpendRedeemer,
  ReserveAction,
  TreasuryDatum,
  TreasuryRedeemer,
} from "../core/types.js";
import {
  assetNameLabels,
  buildGroupCip68Datum,
  createCip68TokenNames,
  getScriptAddress,
  getWalletAddress,
  parseGroupCip68Datum,
  patchInlineDatum,
  reserveTokenName,
  resolveUtxoByOutRef,
  resolveUtxoByUnit,
} from "../core/utils/index.js";
import { DcuError, TransactionBuildError, SetupError } from "../core/errors.js";
import { Protocol } from "../core/validators/constants.js";
import { effectiveScriptRefs, ScriptRefs } from "../core/scripts.js";
import { attachFamilyWithdrawal } from "../core/familyWithdraw.js";
import {
  AdminAuthConfig,
  applyAdminWitness,
  payAdminReturn,
} from "../multisig/index.js";

/**
 * Negative-proof harness.
 *
 * Builds transactions the on-chain validators MUST reject and captures the
 * rejection as machine-readable evidence. The endpoints' pre-flight guards
 * (config-safety envelope, commitment format) stop invalid requests before a
 * transaction exists, so proving the VALIDATOR enforces the same rules needs
 * builders that construct those transactions anyway — that is this module.
 *
 * The security boundary is the validator, not the SDK guard: anyone can build
 * these transactions with raw Lucid. The harness makes the rejection
 * reproducible and auditable instead of hypothetical.
 *
 * Nothing here is ever signed or submitted. A proof ends at evaluation:
 * `localUPLCEval: true` (default) evaluates with the real UPLC machine against
 * current chain state; `localUPLCEval: false` sends the draft transaction to
 * the provider's evaluator (e.g. Blockfrost `/utils/txs/evaluate`) — the
 * third-party attestation used for live evidence runs. Either way a rejected
 * draft never reaches the chain, which is why the evidence record keeps the
 * full evaluator error, the attempted datum, and confirmation that the seed
 * UTxO stayed unspent — a rejected transaction has no tx hash to cite.
 */

// --- Evidence -----------------------------------------------------------------

/** The deployment the proof ran against, straight from the protocol context. */
export type DeploymentIdentity = {
  network: string;
  settingsPolicy: string;
  groupPolicyId: string;
  treasuryPolicyId: string;
  accountPolicyId: string;
};

export const deploymentIdentity = (
  protocol: Protocol,
  network: string,
): DeploymentIdentity => ({
  network,
  settingsPolicy: protocol.settingsPolicy,
  groupPolicyId: protocol.groupPolicyId,
  treasuryPolicyId: protocol.treasuryPolicyId,
  accountPolicyId: protocol.accountPolicyId,
});

export type EvaluationMode = "local-uplc" | "provider";

export type RejectionEvidence = {
  /** Case label, e.g. "C1 create-group recovery_threshold=1". */
  label: string;
  rejected: true;
  /** Full evaluator error, verbatim. */
  evaluatorError: string;
  /** CBOR hex of the datum the transaction tried to create, when applicable. */
  attemptedDatum: string | null;
  evaluation: EvaluationMode;
  deployment: DeploymentIdentity;
  /** ISO-8601 capture time. */
  timestamp: string;
  /** The input the rejected transaction tried to spend, when applicable. */
  seedOutRef?: OutRef;
  /** True when the seed UTxO was re-queried after the rejection and found unspent. */
  seedUnspentAfter?: boolean;
};

/** The build was ACCEPTED — the validator did not reject the transaction. */
export class NegativeProofAcceptedError extends EffectData.TaggedError(
  "NegativeProofAcceptedError",
)<{
  readonly label: string;
  readonly message: string;
}> {}

export type CaptureConfig = {
  label: string;
  deployment: DeploymentIdentity;
  evaluation: EvaluationMode;
  /** CBOR hex of the datum under test, recorded in the evidence. */
  attemptedDatum?: string;
  /** When given, the harness re-queries this out-ref after the rejection. */
  seedOutRef?: OutRef;
};

/**
 * Run a transaction-BUILDING program and capture its evaluation rejection.
 *
 * - Build fails with `TransactionBuildError` (the evaluation error channel) →
 *   evidence record, including a fresh unspent check on `seedOutRef`.
 * - Build fails with any other `DcuError` → propagated: the fixture is broken,
 *   not the proof.
 * - Build SUCCEEDS → `NegativeProofAcceptedError`: the validator accepted a
 *   transaction it must reject. The built transaction is discarded, never
 *   signed, never submitted.
 */
export const captureRejection = <A>(
  lucid: LucidEvolution,
  config: CaptureConfig,
  buildProgram: Effect.Effect<A, DcuError, never>,
): Effect.Effect<
  RejectionEvidence,
  NegativeProofAcceptedError | DcuError,
  never
> =>
  Effect.matchEffect(buildProgram, {
    onFailure: (e) =>
      e._tag === "TransactionBuildError"
        ? Effect.gen(function* () {
            let seedUnspentAfter: boolean | undefined = undefined;
            if (config.seedOutRef) {
              const found = yield* Effect.tryPromise({
                try: () => lucid.utxosByOutRef([config.seedOutRef!]),
                catch: (err) =>
                  new SetupError({
                    message: `negative-proof seed re-query failed: ${err}`,
                  }),
              });
              seedUnspentAfter = found.filter(Boolean).length > 0;
            }
            return {
              label: config.label,
              rejected: true as const,
              evaluatorError: e.error,
              attemptedDatum: config.attemptedDatum ?? null,
              evaluation: config.evaluation,
              deployment: config.deployment,
              timestamp: new Date().toISOString(),
              ...(config.seedOutRef
                ? { seedOutRef: config.seedOutRef, seedUnspentAfter }
                : {}),
            };
          })
        : Effect.fail(e),
    onSuccess: () =>
      Effect.fail(
        new NegativeProofAcceptedError({
          label: config.label,
          message:
            "the validator ACCEPTED a transaction this proof requires it to reject — do not deploy until this is understood",
        }),
      ),
  });

// --- Raw builders ---------------------------------------------------------------
// Each mirrors its endpoint's transaction exactly, minus the pre-flight guard,
// and takes the raw datum fields the guard would have blocked.

export type RawCreateGroupParams = {
  /** Arbitrary group datum — the config-safety envelope is NOT checked here. */
  groupDatum: GroupDatum;
  groupName?: string;
  utxoToSpend: OutRef;
  scriptRefs?: ScriptRefs;
  /** false = provider evaluation (live evidence runs). Default true. */
  localUPLCEval?: boolean;
};

/**
 * The `createGroup` transaction without the config-safety envelope guard —
 * covers matrix cases C1 (recovery_threshold below floor), C2
 * (recovery_timelock below floor), C3 (recommit_window below floor).
 * Returns the attempted CIP-68 datum alongside the build program so the
 * evidence can cite the exact bytes the validator rejected.
 */
export const rawCreateGroup = (
  protocol: Protocol,
  lucid: LucidEvolution,
  params: RawCreateGroupParams,
): {
  attemptedDatum: string;
  program: Effect.Effect<TxSignBuilder, DcuError, never>;
} => {
  const metadata = new Map([
    [fromText("name"), fromText(params.groupName ?? "negative-proof")],
  ]);
  const attemptedDatum = buildGroupCip68Datum(metadata, 1n, params.groupDatum);

  const program: Effect.Effect<TxSignBuilder, DcuError, never> = Effect.gen(
    function* () {
      const {
        groupValidator,
        groupPolicyId,
        treasuryPolicyId,
        treasuryValidator,
        settingsUnit,
      } = protocol;
      const { groupDatum, utxoToSpend } = params;

      const address = yield* getWalletAddress(lucid);
      const groupAddress = yield* getScriptAddress(
        lucid,
        groupValidator.spendGroup,
      );

      const utxo = yield* resolveUtxoByOutRef(lucid, utxoToSpend);
      const { refTokenName, userTokenName } =
        yield* createCip68TokenNames(utxo);

      const refToken = toUnit(groupPolicyId, refTokenName);
      const userToken = toUnit(groupPolicyId, userTokenName);
      const mintingAssets: Assets = { [refToken]: 1n, [userToken]: 1n };

      const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
      const reserveToken = toUnit(
        treasuryPolicyId,
        reserveTokenName(refTokenName),
      );
      const reserveDatum: TreasuryDatum = {
        ReserveState: {
          group_reference_tokenname: refTokenName,
          standin_rounds: 0n,
        },
      };
      const treasuryAddress = yield* getScriptAddress(
        lucid,
        treasuryValidator.spendTreasury,
      );
      const reserveAssets: Assets = {
        [reserveToken]: 1n,
        lovelace: 2_000_000n,
      };
      const createReserveMintRedeemer = Data.to(
        "CreateReserve",
        TreasuryRedeemer,
      );
      const createReserveAction = Data.to(
        {
          CreateAction: {
            covered_inputs: [],
            group_output_index: 0n,
            reserve_output_index: 2n,
          },
        },
        ReserveAction,
      );
      const scriptAssets: Assets =
        groupDatum.creator_bond > 0n
          ? { [refToken]: 1n, lovelace: groupDatum.creator_bond }
          : { [refToken]: 1n };
      const walletAssets: Assets = { [userToken]: 1n };

      const redeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) =>
          Data.to(new Constr(0, [inputIndices[0], 0n])),
        inputs: [utxo],
      };

      const baseTx = lucid
        .newTx()
        .collectFrom([utxo])
        .mintAssets(mintingAssets, redeemer)
        .mintAssets({ [reserveToken]: 1n }, createReserveMintRedeemer)
        .pay.ToContract(
          groupAddress,
          { kind: "inline", value: attemptedDatum },
          scriptAssets,
        )
        .pay.ToAddress(address, walletAssets)
        .pay.ToContract(
          treasuryAddress,
          { kind: "inline", value: Data.to(reserveDatum, TreasuryDatum) },
          reserveAssets,
        )
        .readFrom([settingsUtxo]);

      const scriptRefs = effectiveScriptRefs(params.scriptRefs);
      const network = lucid.config().network!;
      const withGroupValidator = scriptRefs.group
        ? baseTx.readFrom([scriptRefs.group])
        : baseTx.attach.MintingPolicy(groupValidator.mintGroup);
      const withTreasuryValidator = scriptRefs.treasury
        ? withGroupValidator.readFrom([scriptRefs.treasury])
        : withGroupValidator.attach.MintingPolicy(
            treasuryValidator.mintTreasury,
          );
      const withReserveWithdrawal = attachFamilyWithdrawal(
        withTreasuryValidator,
        protocol,
        network,
        "reserve",
        createReserveAction,
        scriptRefs,
      );

      return yield* withReserveWithdrawal
        .completeProgram(
          params.localUPLCEval === false ? { localUPLCEval: false } : {},
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new TransactionBuildError({
                operation: "harness:rawCreateGroup",
                error: String(e),
              }),
          ),
        );
    },
  );

  return { attemptedDatum, program };
};

export type RawCreateAccountParams = {
  selected_out_ref: OutRef;
  /** Arbitrary hex written verbatim to `profile_commitment` — the 0-or-32-byte
   *  format guard is NOT checked here (matrix case C6). */
  profileCommitmentHex: string;
  /** false = provider evaluation (live evidence runs). Default true. */
  localUPLCEval?: boolean;
};

/**
 * The `createAccount` transaction without the commitment-format guard —
 * covers matrix case C6 (a commitment that is neither empty nor 32 bytes).
 */
export const rawCreateAccount = (
  protocol: Protocol,
  lucid: LucidEvolution,
  params: RawCreateAccountParams,
): {
  attemptedDatum: string;
  program: Effect.Effect<TxSignBuilder, DcuError, never>;
} => {
  const accountDatum: AccountDatum = {
    profile_commitment: params.profileCommitmentHex,
  };
  const attemptedDatum = Data.to(accountDatum, AccountDatum);

  const program: Effect.Effect<TxSignBuilder, DcuError, never> = Effect.gen(
    function* () {
      const { accountValidator, accountPolicyId } = protocol;
      const address = yield* getWalletAddress(lucid);
      const accountScriptAddress = yield* getScriptAddress(
        lucid,
        accountValidator.spendAccount,
      );
      const selectedUtxo = yield* resolveUtxoByOutRef(
        lucid,
        params.selected_out_ref,
      );
      const { refTokenName, userTokenName } =
        yield* createCip68TokenNames(selectedUtxo);

      const refToken = toUnit(accountPolicyId, refTokenName);
      const userToken = toUnit(accountPolicyId, userTokenName);

      const redeemer: RedeemerBuilder = {
        kind: "selected",
        makeRedeemer: (inputIndices: bigint[]) =>
          Data.to(
            {
              CreateAccount: {
                input_index: inputIndices[0],
                output_index: 0n,
              },
            },
            AccountRedeemer,
          ),
        inputs: [selectedUtxo],
      };

      return yield* lucid
        .newTx()
        .collectFrom([selectedUtxo])
        .mintAssets({ [refToken]: 1n, [userToken]: 1n }, redeemer)
        .pay.ToAddressWithData(
          accountScriptAddress,
          { kind: "inline", value: attemptedDatum },
          { [refToken]: 1n },
        )
        .pay.ToAddress(address, { [userToken]: 1n })
        .addSigner(address)
        .attach.MintingPolicy(accountValidator.mintAccount)
        .completeProgram(
          params.localUPLCEval === false ? { localUPLCEval: false } : {},
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new TransactionBuildError({
                operation: "harness:rawCreateAccount",
                error: String(e),
              }),
          ),
        );
    },
  );

  return { attemptedDatum, program };
};

export type RawUpdateGroupParams = {
  groupTokenSuffix: string;
  /** Arbitrary group datum — no pre-flight validation (matrix case C4). */
  updatedDatum: GroupDatum;
  /** Replace the CIP-68 metadata map instead of preserving it (matrix case C5:
   *  pass a map with an empty/absent name). */
  metadataOverride?: Map<string, string>;
  /** Replace the CIP-68 version instead of preserving it (matrix case C5). */
  versionOverride?: bigint;
  /** false = provider evaluation (live evidence runs). Default true. */
  localUPLCEval?: boolean;
} & AdminAuthConfig;

/**
 * The `updateGroup` transaction with the CIP-68 wrapper fields overridable —
 * the endpoint always preserves the on-chain metadata and version, so matrix
 * case C5 (mutating the version / emptying the name pre-join) and C4
 * (lowering an envelope field below its floor) need this raw variant.
 * The datum depends on chain state, so this resolves it first and yields the
 * attempted datum next to the (not yet run) build program — the evidence needs
 * the datum even when the build is rejected.
 */
export const rawUpdateGroup = (
  protocol: Protocol,
  lucid: LucidEvolution,
  params: RawUpdateGroupParams,
): Effect.Effect<
  {
    attemptedDatum: string;
    program: Effect.Effect<TxSignBuilder, DcuError, never>;
  },
  DcuError,
  never
> =>
  Effect.gen(function* () {
    const { groupValidator, groupPolicyId } = protocol;
    const { groupTokenSuffix, updatedDatum } = params;

    const groupRefUnit =
      groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    const adminUnit =
      groupPolicyId + assetNameLabels.prefix222 + groupTokenSuffix;

    const groupUtxoRaw = yield* resolveUtxoByUnit(lucid, groupRefUnit);
    const adminUtxo = yield* resolveUtxoByUnit(lucid, adminUnit);
    const groupUtxo = patchInlineDatum(groupUtxoRaw);

    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);

    const groupRefName = assetNameLabels.prefix100 + groupTokenSuffix;
    const groupAssets: Assets = { ...groupUtxo.assets };

    const attemptedDatum = buildGroupCip68Datum(
      params.metadataOverride ?? groupCip68.metadata,
      params.versionOverride ?? groupCip68.version,
      updatedDatum,
    );

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to<GroupSpendRedeemer>(
          {
            UpdateGroup: {
              group_ref_token_name: groupRefName,
              admin_input_index: inputIndices[0],
              group_input_index: inputIndices[1],
              group_output_index: 0n,
            },
          },
          GroupSpendRedeemer,
        ),
      inputs: [adminUtxo, groupUtxo],
    };

    const baseTx0 = lucid
      .newTx()
      .collectFrom([adminUtxo])
      .collectFrom([groupUtxo], redeemer)
      .pay.ToContract(
        groupUtxo.address,
        { kind: "inline", value: attemptedDatum },
        groupAssets,
      )
      .attach.SpendingValidator(groupValidator.spendGroup);

    const withSigners = applyAdminWitness(
      payAdminReturn(baseTx0, params, adminUtxo),
      params,
    );

    const program = withSigners
      .completeProgram(
        params.localUPLCEval === false ? { localUPLCEval: false } : {},
      )
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "harness:rawUpdateGroup",
              error: String(e),
            }),
        ),
      );
    return { attemptedDatum, program };
  });
