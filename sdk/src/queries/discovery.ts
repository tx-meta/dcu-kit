import {
  paymentCredentialOf,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import type { Protocol } from "../core/validators/constants.js";
import type { GroupDatum, TreasuryDatum } from "../core/types.js";
import { TreasuryDatumSchema } from "../core/types.js";
import {
  assetNameLabels,
  decodeGroupMetadata,
  getScriptAddress,
  parseGroupCip68Datum,
  parseSafeDatum,
  patchInlineDatum,
  getWalletAddress,
  getWalletUtxos,
  resolveUtxoByUnit,
} from "../core/utils/index.js";
import {
  ConfigurationError,
  type DcuError,
  LucidError,
} from "../core/errors.js";
import { makeReturn } from "../core/utils/index.js";
import { blockfrostTipSlot, type BlockfrostConfig } from "./blockfrost.js";

export type PageRequest = {
  /** Stable out-ref cursor returned by the previous page. */
  cursor?: string;
  /** Page size, 1..100. Defaults to 25. */
  limit?: number;
  /** Optional authoritative source for the observation slot. */
  blockfrost?: BlockfrostConfig;
};

export type ReadDiagnostic = {
  kind: "MalformedDatum" | "UnattributablePenaltyState";
  outRef: string;
  error: string;
};

export type DiscoveryPage<T> = {
  items: T[];
  nextCursor: string | null;
  /** Null when the provider abstraction does not expose a trustworthy tip. */
  observedSlot: bigint | null;
  /** Whether the provider performed a bounded unit lookup or a full scan. */
  queryStrategy: "asset-indexed" | "full-address-scan";
  diagnostics: ReadDiagnostic[];
};

export type GroupSummary = {
  tokenSuffix: string;
  refUnit: string;
  outRef: string;
  address: string;
  name: string | null;
  description: string | null;
  datum: GroupDatum;
};

export type MemberSummary = {
  tokenName: string;
  outRef: string;
  address: string;
  status: "TreasuryState" | "PenaltyState" | "DefaultState";
  paymentCredential: string | null;
  roundsPaid: bigint | null;
  claimableBalance: bigint | null;
  graceExpiresAt: bigint | null;
  graceExtensionsUsed: bigint | null;
};

export type MembershipSummary = MemberSummary & {
  groupTokenSuffix: string;
};

const outRefOf = (utxo: UTxO): string => `${utxo.txHash}#${utxo.outputIndex}`;

const ordered = (utxos: UTxO[]): UTxO[] =>
  [...utxos].sort(
    (a, b) => a.txHash.localeCompare(b.txHash) || a.outputIndex - b.outputIndex,
  );

const pageBounds = (
  request: PageRequest,
): Effect.Effect<{ cursor?: string; limit: number }, ConfigurationError> => {
  const limit = request.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return Effect.fail(
      new ConfigurationError({
        configKey: "limit",
        message: `limit must be an integer from 1 to 100, got ${limit}`,
      }),
    );
  }
  if (
    request.cursor !== undefined &&
    !/^[0-9a-f]{64}#\d+$/i.test(request.cursor)
  ) {
    return Effect.fail(
      new ConfigurationError({
        configKey: "cursor",
        message: "cursor must be a transaction-hash#output-index out-ref",
      }),
    );
  }
  return Effect.succeed({ cursor: request.cursor, limit });
};

const pageUtxos = (
  utxos: UTxO[],
  cursor: string | undefined,
  limit: number,
): { selected: UTxO[]; nextCursor: string | null } => {
  const isAfterCursor = (utxo: UTxO): boolean => {
    if (cursor === undefined) return true;
    const separator = cursor.lastIndexOf("#");
    const hash = cursor.slice(0, separator);
    const outputIndex = Number(cursor.slice(separator + 1));
    return (
      utxo.txHash.localeCompare(hash) > 0 ||
      (utxo.txHash === hash && utxo.outputIndex > outputIndex)
    );
  };
  const after = ordered(utxos).filter(isAfterCursor);
  const selected = after.slice(0, limit);
  return {
    selected,
    nextCursor:
      after.length > limit && selected.length > 0
        ? outRefOf(selected[selected.length - 1]!)
        : null,
  };
};

const utxosAt = (
  lucid: LucidEvolution,
  address: string,
): Effect.Effect<UTxO[], LucidError> =>
  Effect.tryPromise({
    try: () => lucid.utxosAt(address),
    catch: (cause) =>
      new LucidError({
        message: `provider failed while listing UTxOs at ${address}`,
        cause,
      }),
  });

const groupSuffix = (protocol: Protocol, utxo: UTxO): string | null => {
  const unit = Object.keys(utxo.assets).find(
    (candidate) =>
      candidate.startsWith(protocol.groupPolicyId) &&
      candidate
        .slice(protocol.groupPolicyId.length)
        .startsWith(assetNameLabels.prefix100),
  );
  return unit
    ? unit.slice(
        protocol.groupPolicyId.length + assetNameLabels.prefix100.length,
      )
    : null;
};

const decodeGroup = (
  protocol: Protocol,
  raw: UTxO,
): Effect.Effect<GroupSummary, DcuError> =>
  Effect.gen(function* () {
    const utxo = patchInlineDatum(raw);
    const tokenSuffix = groupSuffix(protocol, utxo);
    if (!tokenSuffix) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "groupUtxo",
          message: `group reference token missing at ${outRefOf(utxo)}`,
        }),
      );
    }
    const decoded = yield* parseGroupCip68Datum(utxo.datum);
    const metadata = decodeGroupMetadata(decoded.metadata);
    return {
      tokenSuffix,
      refUnit: protocol.groupPolicyId + assetNameLabels.prefix100 + tokenSuffix,
      outRef: outRefOf(utxo),
      address: utxo.address,
      name: metadata.name ?? null,
      description: metadata.description ?? null,
      datum: decoded.groupDatum,
    };
  });

type DiscoverableTreasuryDatum = Extract<
  TreasuryDatum,
  | { TreasuryState: unknown }
  | { PenaltyState: unknown }
  | { DefaultState: unknown }
>;

const isDiscoverableTreasuryDatum = (
  datum: TreasuryDatum,
): datum is DiscoverableTreasuryDatum =>
  "TreasuryState" in datum ||
  "PenaltyState" in datum ||
  "DefaultState" in datum;

export const summarizeMemberDatum = (
  datum: DiscoverableTreasuryDatum,
  utxo: UTxO,
): MemberSummary => {
  if ("TreasuryState" in datum) {
    const state = datum.TreasuryState;
    return {
      tokenName: state.member_reference_tokenname,
      outRef: outRefOf(utxo),
      address: utxo.address,
      status: "TreasuryState",
      paymentCredential: state.member_payment_credential,
      roundsPaid: state.rounds_paid,
      claimableBalance: state.claimable_balance,
      graceExpiresAt: null,
      graceExtensionsUsed: null,
    };
  }
  if ("PenaltyState" in datum) {
    const state = datum.PenaltyState;
    return {
      tokenName: state.member_reference_tokenname,
      outRef: outRefOf(utxo),
      address: utxo.address,
      status: "PenaltyState",
      paymentCredential: null,
      roundsPaid: null,
      claimableBalance: null,
      graceExpiresAt: null,
      graceExtensionsUsed: null,
    };
  }
  const state = datum.DefaultState;
  return {
    tokenName: state.member_reference_tokenname,
    outRef: outRefOf(utxo),
    address: utxo.address,
    status: "DefaultState",
    paymentCredential: state.member_payment_credential,
    roundsPaid: state.rounds_paid,
    claimableBalance: state.claimable_balance,
    graceExpiresAt: state.grace_expires_at,
    graceExtensionsUsed: state.grace_extensions_used,
  };
};

const observedSlot = (
  request: PageRequest,
): Effect.Effect<bigint | null, DcuError> =>
  request.blockfrost
    ? blockfrostTipSlot(request.blockfrost)
    : Effect.succeed(null);

export const getGroupProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  tokenSuffix: string,
): Effect.Effect<GroupSummary, DcuError> =>
  Effect.gen(function* () {
    const unit =
      protocol.groupPolicyId + assetNameLabels.prefix100 + tokenSuffix;
    const utxo = yield* resolveUtxoByUnit(lucid, unit);
    return yield* decodeGroup(protocol, utxo);
  });

export const listGroupsProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  request: PageRequest = {},
): Effect.Effect<DiscoveryPage<GroupSummary>, DcuError> =>
  Effect.gen(function* () {
    const bounds = yield* pageBounds(request);
    const address = yield* getScriptAddress(
      lucid,
      protocol.groupValidator.spendGroup,
    );
    const all = (yield* utxosAt(lucid, address)).filter(
      (utxo) => groupSuffix(protocol, utxo) !== null,
    );
    const { selected, nextCursor } = pageUtxos(
      all,
      bounds.cursor,
      bounds.limit,
    );
    const decoded = yield* Effect.forEach(
      selected,
      (utxo) => Effect.either(decodeGroup(protocol, utxo)),
      { concurrency: "unbounded" },
    );
    const items: GroupSummary[] = [];
    const diagnostics: ReadDiagnostic[] = [];
    decoded.forEach((result, index) => {
      if (result._tag === "Right") items.push(result.right);
      else
        diagnostics.push({
          kind: "MalformedDatum",
          outRef: outRefOf(selected[index]!),
          error: String(result.left),
        });
    });
    return {
      items,
      nextCursor,
      observedSlot: yield* observedSlot(request),
      queryStrategy: "full-address-scan" as const,
      diagnostics,
    };
  });

export const listMembersProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  tokenSuffix: string,
  request: PageRequest = {},
): Effect.Effect<DiscoveryPage<MemberSummary>, DcuError> =>
  Effect.gen(function* () {
    const bounds = yield* pageBounds(request);
    const group = yield* getGroupProgram(protocol, lucid, tokenSuffix);
    const groupRefName = assetNameLabels.prefix100 + group.tokenSuffix;
    const address = yield* getScriptAddress(
      lucid,
      protocol.treasuryValidator.spendTreasury,
    );
    const all = yield* utxosAt(lucid, address);

    const candidates: Array<{ utxo: UTxO; datum: TreasuryDatum }> = [];
    const diagnostics: ReadDiagnostic[] = [];
    for (const raw of ordered(all)) {
      const utxo = patchInlineDatum(raw);
      const result = yield* Effect.either(
        parseSafeDatum(utxo.datum, TreasuryDatumSchema),
      );
      if (result._tag === "Left") {
        diagnostics.push({
          kind: "MalformedDatum",
          outRef: outRefOf(utxo),
          error: String(result.left),
        });
        continue;
      }
      const datum = result.right as unknown as TreasuryDatum;
      const state = isDiscoverableTreasuryDatum(datum)
        ? "TreasuryState" in datum
          ? datum.TreasuryState
          : "PenaltyState" in datum
            ? datum.PenaltyState
            : datum.DefaultState
        : null;
      if (state?.group_reference_tokenname === groupRefName) {
        candidates.push({ utxo, datum });
      }
    }

    const { selected, nextCursor } = pageUtxos(
      candidates.map((candidate) => candidate.utxo),
      bounds.cursor,
      bounds.limit,
    );
    const byRef = new Map(
      candidates.map((candidate) => [outRefOf(candidate.utxo), candidate]),
    );
    const items = selected.map((utxo): MemberSummary => {
      const datum = byRef.get(outRefOf(utxo))!.datum;
      if (!isDiscoverableTreasuryDatum(datum)) {
        throw new Error(
          `internal discovery invariant violated at ${outRefOf(utxo)}`,
        );
      }
      return summarizeMemberDatum(datum, utxo);
    });
    return {
      items,
      nextCursor,
      observedSlot: yield* observedSlot(request),
      queryStrategy: "full-address-scan" as const,
      diagnostics,
    };
  });

/** Lists every ROSCA membership controlled by a payment key hash. */
export const listMembershipsProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  paymentCredential: string,
  request: PageRequest = {},
): Effect.Effect<DiscoveryPage<MembershipSummary>, DcuError> =>
  Effect.gen(function* () {
    if (!/^[0-9a-f]{56}$/i.test(paymentCredential)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "paymentCredential",
          message: "paymentCredential must be a 28-byte key hash",
        }),
      );
    }
    const bounds = yield* pageBounds(request);
    const address = yield* getScriptAddress(
      lucid,
      protocol.treasuryValidator.spendTreasury,
    );
    const all = yield* utxosAt(lucid, address);
    const candidates: Array<{
      utxo: UTxO;
      datum: Extract<
        DiscoverableTreasuryDatum,
        { TreasuryState: unknown } | { DefaultState: unknown }
      >;
    }> = [];
    const diagnostics: ReadDiagnostic[] = [];
    for (const raw of ordered(all)) {
      const utxo = patchInlineDatum(raw);
      const parsed = yield* Effect.either(
        parseSafeDatum(utxo.datum, TreasuryDatumSchema),
      );
      if (parsed._tag === "Left") {
        diagnostics.push({
          kind: "MalformedDatum",
          outRef: outRefOf(utxo),
          error: String(parsed.left),
        });
        continue;
      }
      const datum = parsed.right as unknown as TreasuryDatum;
      if (!isDiscoverableTreasuryDatum(datum)) continue;
      if ("PenaltyState" in datum) {
        diagnostics.push({
          kind: "UnattributablePenaltyState",
          outRef: outRefOf(utxo),
          error:
            "PenaltyState has no payment credential; use listMembers(group) to enumerate it",
        });
        continue;
      }
      const state =
        "TreasuryState" in datum ? datum.TreasuryState : datum.DefaultState;
      if (
        state.member_payment_credential.toLowerCase() ===
        paymentCredential.toLowerCase()
      )
        candidates.push({ utxo, datum });
    }
    const { selected, nextCursor } = pageUtxos(
      candidates.map(({ utxo }) => utxo),
      bounds.cursor,
      bounds.limit,
    );
    const byRef = new Map(
      candidates.map((candidate) => [outRefOf(candidate.utxo), candidate]),
    );
    const items = selected.map((utxo): MembershipSummary => {
      const datum = byRef.get(outRefOf(utxo))!.datum;
      const state =
        "TreasuryState" in datum ? datum.TreasuryState : datum.DefaultState;
      const groupRefName = state.group_reference_tokenname;
      return {
        ...summarizeMemberDatum(datum, utxo),
        groupTokenSuffix: groupRefName.startsWith(assetNameLabels.prefix100)
          ? groupRefName.slice(assetNameLabels.prefix100.length)
          : groupRefName,
      };
    });
    return {
      items,
      nextCursor,
      observedSlot: yield* observedSlot(request),
      queryStrategy: "full-address-scan" as const,
      diagnostics,
    };
  });

/** Connected-wallet convenience over {@link listMembershipsProgram}. */
export const listMyMembershipsProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  request: PageRequest = {},
): Effect.Effect<DiscoveryPage<MembershipSummary>, DcuError> =>
  Effect.gen(function* () {
    const walletAddress = yield* getWalletAddress(lucid);
    const credential = paymentCredentialOf(walletAddress);
    if (credential.type !== "Key") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "wallet",
          message: "connected wallet does not expose a payment key credential",
        }),
      );
    }
    const bounds = yield* pageBounds(request);
    const treasuryAddress = yield* getScriptAddress(
      lucid,
      protocol.treasuryValidator.spendTreasury,
    );
    const walletUtxos = yield* getWalletUtxos(lucid);
    // The wallet's account-policy CIP-68 user token is the ownership marker.
    // Join mirrors that asset name under the treasury policy for membership.
    const userUnits = Array.from(
      new Set(
        walletUtxos.flatMap((utxo) =>
          Object.keys(utxo.assets).filter(
            (unit) =>
              unit.startsWith(protocol.accountPolicyId) &&
              unit
                .slice(protocol.accountPolicyId.length)
                .startsWith(assetNameLabels.prefix222),
          ),
        ),
      ),
    );
    const candidateLists = yield* Effect.forEach(
      userUnits,
      (userUnit) => {
        const name = userUnit.slice(protocol.accountPolicyId.length);
        // Join mints the treasury membership token with this same CIP-68 user
        // asset name; only the policy changes from account to treasury.
        const refUnit = protocol.treasuryPolicyId + name;
        return Effect.tryPromise({
          try: () => lucid.utxosAtWithUnit(treasuryAddress, refUnit),
          catch: (cause) =>
            new LucidError({
              message: `provider failed while resolving membership unit ${refUnit}`,
              cause,
            }),
        });
      },
      { concurrency: "unbounded" },
    );
    const all = ordered(candidateLists.flat());
    const candidates: Array<{
      utxo: UTxO;
      datum: Extract<
        DiscoverableTreasuryDatum,
        { TreasuryState: unknown } | { DefaultState: unknown }
      >;
    }> = [];
    const diagnostics: ReadDiagnostic[] = [];
    for (const raw of all) {
      const utxo = patchInlineDatum(raw);
      const parsed = yield* Effect.either(
        parseSafeDatum(utxo.datum, TreasuryDatumSchema),
      );
      if (parsed._tag === "Left") {
        diagnostics.push({
          kind: "MalformedDatum",
          outRef: outRefOf(utxo),
          error: String(parsed.left),
        });
        continue;
      }
      const datum = parsed.right as unknown as TreasuryDatum;
      if (
        ("TreasuryState" in datum || "DefaultState" in datum) &&
        ("TreasuryState" in datum
          ? datum.TreasuryState.member_payment_credential
          : datum.DefaultState.member_payment_credential
        ).toLowerCase() === credential.hash.toLowerCase()
      )
        candidates.push({ utxo, datum });
    }
    const { selected, nextCursor } = pageUtxos(
      candidates.map(({ utxo }) => utxo),
      bounds.cursor,
      bounds.limit,
    );
    const byRef = new Map(
      candidates.map((candidate) => [outRefOf(candidate.utxo), candidate]),
    );
    const items = selected.map((utxo): MembershipSummary => {
      const datum = byRef.get(outRefOf(utxo))!.datum;
      const state =
        "TreasuryState" in datum ? datum.TreasuryState : datum.DefaultState;
      const groupRefName = state.group_reference_tokenname;
      return {
        ...summarizeMemberDatum(datum, utxo),
        groupTokenSuffix: groupRefName.startsWith(assetNameLabels.prefix100)
          ? groupRefName.slice(assetNameLabels.prefix100.length)
          : groupRefName,
      };
    });
    return {
      items,
      nextCursor,
      observedSlot: yield* observedSlot(request),
      queryStrategy: "asset-indexed" as const,
      diagnostics,
    };
  });

export const getGroup = (
  protocol: Protocol,
  lucid: LucidEvolution,
  tokenSuffix: string,
) => makeReturn(getGroupProgram(protocol, lucid, tokenSuffix));

export const listGroups = (
  protocol: Protocol,
  lucid: LucidEvolution,
  request: PageRequest = {},
) => makeReturn(listGroupsProgram(protocol, lucid, request));

export const listMembers = (
  protocol: Protocol,
  lucid: LucidEvolution,
  tokenSuffix: string,
  request: PageRequest = {},
) => makeReturn(listMembersProgram(protocol, lucid, tokenSuffix, request));

export const listMemberships = (
  protocol: Protocol,
  lucid: LucidEvolution,
  paymentCredential: string,
  request: PageRequest = {},
) =>
  makeReturn(
    listMembershipsProgram(protocol, lucid, paymentCredential, request),
  );

export const listMyMemberships = (
  protocol: Protocol,
  lucid: LucidEvolution,
  request: PageRequest = {},
) => makeReturn(listMyMembershipsProgram(protocol, lucid, request));
