/**
 * Test Datum Factories
 *
 * Factory functions for creating test datums with sensible defaults.
 * Eliminates boilerplate and ensures consistency across tests.
 *
 * Also hosts the emulator scaffolding shared by the governance-coupled suites
 * (`governance.test.ts`, `governanceSavingsGate.test.ts`) — one copy, so the
 * membership policy and the reference-script deploys cannot drift apart.
 */

import {
  CML,
  credentialToAddress,
  Data,
  Emulator,
  generateEmulatorAccount,
  getAddressDetails,
  Lucid,
  LucidEvolution,
  mintingPolicyToId,
  PROTOCOL_PARAMETERS_DEFAULT,
  Script,
  scriptFromNative,
  validatorToAddress,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum } from "../src/core/types.js";
import { assetNameLabels, signAndSubmit } from "../src/core/utils/index.js";
import { SavingsDatum } from "../src/savings/types.js";
import type { GovScriptRefs } from "../src/governance/utils.js";
import type { GovernanceInstance } from "../src/governance/validators.js";

/**
 * Extracts the shared 28-byte suffix from a CIP-68 token in a UTxO.
 * Works for both prefix100 and prefix222 — strips the policyId and the 4-byte prefix.
 */
export function extractTokenSuffix(
  utxo: UTxO,
  policyId: string,
  prefix: string,
): string {
  const key = Object.keys(utxo.assets).find(
    (k) =>
      k.startsWith(policyId) && k.slice(policyId.length).startsWith(prefix),
  );
  if (!key)
    throw new Error(
      `No token with prefix ${prefix} found in UTxO ${utxo.txHash}#${utxo.outputIndex}`,
    );
  return key.slice(policyId.length + prefix.length);
}

/**
 * Creates a default GroupDatum for testing.
 *
 * All fields use safe defaults that will pass validator checks.
 * Override any field by passing a partial object.
 *
 * @param overrides - Fields to override
 * @returns Complete GroupDatum
 *
 * @example
 * ```typescript
 * // Default datum
 * const datum = createDefaultGroupDatum();
 *
 * // Custom member count
 * const datum = createDefaultGroupDatum({ member_count: 5n });
 * ```
 */
export const createDefaultGroupDatum = (
  overrides?: Partial<GroupDatum>,
): GroupDatum => ({
  // contribution_fee_policyid: ADA is empty bytes "" — NOT "00" (which is a 1-byte non-ADA token).
  // The Aiken validator uses assets.quantity_of(value, policyid, assetname) for fee checks;
  // quantity_of(value, "", "") returns lovelace. Using "00" would look up a non-existent
  // token and return 0, causing fees_locked? to fail with "exited prematurely".
  contribution_fee_policyid: "",
  contribution_fee_assetname: "",
  contribution_fee: 2_000_000n, // 2 ADA — must be > 0 per Aiken CreateGroup check
  joining_fee_policyid: "",
  joining_fee_assetname: "",
  joining_fee: 0n,
  penalty_fee_policyid: "",
  penalty_fee_assetname: "",
  penalty_fee: 2_000_000n, // 2 ADA — must be >= 0
  grace_period_length: 0n,
  creator_bond: 0n, // 0 for test groups (no bond required)
  interval_length: 3_600_000n, // 1 hour in milliseconds
  // num_rounds is 0 at creation — assigned to member_count at startGroup.
  // Required by validate_create_group (num_rounds == 0 check).
  num_rounds: 0n,
  // Within the protocol ceiling (max_group_members = 20). Was 30 before the scale cap.
  max_members: 20n,
  member_count: 0n,
  // 0 at creation; startGroup sets it to member_count. Active-cycle tests override explicitly.
  active_member_count: 0n,
  is_active: true,
  is_started: false,
  last_distributed_round: -1n,
  // start_time MUST be 0 at creation — validate_create_group enforces (start_time == 0).
  // startGroup sets it to get_lower_bound(tx) when sealing membership.
  start_time: 0n,
  // Fixed 28-byte test placeholder for creator_payment_credential (VK kind).
  // With joining_fee: 0n this field is unused by the treasury validator,
  // but validate_create_group requires a 28-byte hash (56 hex chars).
  creator_payment_credential: {
    VerificationKey: [
      "a0a1a2a3a4a5a6a7a8a9b0b1b2b3b4b5b6b7b8b9c0c1c2c3c4c5c6c7",
    ] as [string],
  },
  member_token_names: [],
  // 1 = PerRound (traditional ROSCA, default). Set to max_members for FullUpfront,
  // or any k in [1, max_members] for partial collateral.
  collateral_rounds: 1n,
  // Push = current direct-wallet-payout behaviour (default). Pull groups override this.
  payout_mode: "Push",
  // 2 = the envelope floor (min_recovery_threshold) — one member can never
  // satisfy a recovery quorum alone.
  recovery_threshold: 2n,
  // 259_200_000 ms = 3 days veto window before a recovery can execute.
  recovery_timelock: 259_200_000n,
  member_slots: [],
  era_start_round: 0n,
  recommit_window: 259_200_000n,
  reserve_join_levy: 0n,
  reserve_round_levy: 0n,
  ...overrides,
});

/**
 * Reads the CIP-20 payload (label 674) back out of a built transaction via CML,
 * as canonical metadatum JSON. `undefined` when the tx carries no auxiliary
 * metadata at all.
 */
export const readCip20 = (txCbor: string): string | undefined =>
  CML.Transaction.from_cbor_hex(txCbor)
    .auxiliary_data()
    ?.metadata()
    ?.get(674n)
    ?.to_json();

// ---------------------------------------------------------------------------
// Shared governance-suite scaffolding
// ---------------------------------------------------------------------------

/**
 * Advance the emulator clock past a POSIX-ms deadline (slots are 1s).
 * Validity bounds are checked against the slot, so overshoot by a margin.
 */
export const advancePast = (emulator: Emulator, deadlineMs: bigint) =>
  Effect.sync(() => {
    while (BigInt(emulator.now()) <= deadlineMs + 2_000n) {
      emulator.awaitBlock(10);
    }
  });

/**
 * A permissionless "membership" policy: eligibility = holding a token of it.
 * Stands in for the savings user-token policy in cross-module production use.
 */
export const membershipScript = scriptFromNative({ type: "all", scripts: [] });
export const MEMBER_POLICY = mintingPolicyToId(membershipScript);
// CIP-68 named, like the savings user tokens this policy stands in for: the
// governance fund binding finds a member's account by the (100) twin of the
// (222) token they present, so the pair has to share a suffix.
export const MEMBER_SUFFIX = "11".repeat(28);
export const MEMBER_NAME = assetNameLabels.prefix222 + MEMBER_SUFFIX;
export const MEMBER_REF_NAME = assetNameLabels.prefix100 + MEMBER_SUFFIX;
export const MEMBER_UNIT = MEMBER_POLICY + MEMBER_NAME;
export const MEMBER_REF_UNIT = MEMBER_POLICY + MEMBER_REF_NAME;

/**
 * Parks the member's (100) account UTxO with a savings MemberAccount datum
 * naming `fundId`. Governance reference-reads it to bind a voter to one fund
 * and, under ShareWeighted, to read their share units.
 */
export const mintMemberAccount = (
  lucid: LucidEvolution,
  fundId: string,
  shareUnits = 1n,
  refUnit: string = MEMBER_REF_UNIT,
) =>
  Effect.gen(function* () {
    const datum: SavingsDatum = {
      MemberAccount: {
        fund_id: fundId,
        share_units: shareUnits,
        social_paid: 0n,
        borrowed: 0n,
        consent: true,
        joined_at: 0n,
      },
    };
    // Parked OFF-wallet: a UTxO cannot be both spent and referenced in one
    // transaction, so leaving it in the wallet would let coin selection consume
    // the very input governance reads.
    const network = lucid.config().network ?? "Custom";
    const address = validatorToAddress(network, membershipScript);
    const tx = yield* Effect.promise(() =>
      lucid
        .newTx()
        .mintAssets({ [refUnit]: 1n })
        .attach.MintingPolicy(membershipScript)
        .pay.ToAddressWithData(
          address,
          { kind: "inline", value: Data.to(datum, SavingsDatum) },
          { [refUnit]: 1n },
        )
        .complete(),
    );
    yield* signAndSubmit(tx);
  });

/** Mint one membership token to the connected wallet. */
export const mintMembership = (
  lucid: LucidEvolution,
  unit: string = MEMBER_UNIT,
) =>
  Effect.gen(function* () {
    const tx = yield* Effect.promise(() =>
      lucid
        .newTx()
        .mintAssets({ [unit]: 1n })
        .attach.MintingPolicy(membershipScript)
        .complete(),
    );
    yield* signAndSubmit(tx);
  });

/** A creator plus two members, all seed wallets so each can pay fees and sign. */
export type GovTestContext = {
  lucid: LucidEvolution;
  emulator: Emulator;
  creator: { seedPhrase: string; address: string };
  member1: { seedPhrase: string; address: string };
  member2: { seedPhrase: string; address: string };
};

export const makeGovContext = Effect.gen(function* () {
  const creator = generateEmulatorAccount({ lovelace: 2_000_000_000n });
  const member1 = generateEmulatorAccount({ lovelace: 500_000_000n });
  const member2 = generateEmulatorAccount({ lovelace: 500_000_000n });
  const emulator = new Emulator(
    [creator, member1, member2],
    PROTOCOL_PARAMETERS_DEFAULT,
  );
  const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));
  return { lucid, emulator, creator, member1, member2 } as GovTestContext;
});

/** The minimum a context needs to host a reference-script deploy. */
type DeployContext = {
  lucid: LucidEvolution;
  emulator: Emulator;
  creator: { address: string };
};

/** Publish `script` at the creator's shorter enterprise address. */
export const deployScriptRef = (
  ctx: DeployContext,
  script: Script,
  lovelace = 20_000_000n,
): Effect.Effect<UTxO> =>
  Effect.gen(function* () {
    const { lucid, emulator } = ctx;
    const payment = getAddressDetails(ctx.creator.address).paymentCredential;
    if (!payment) throw new Error("creator has no payment credential");
    const address = credentialToAddress(lucid.config().network!, payment);
    const tx = yield* Effect.promise(() =>
      lucid
        .newTx()
        .pay.ToAddressWithData(address, undefined, { lovelace }, script)
        .complete(),
    );
    const signed = yield* Effect.promise(() => tx.sign.withWallet().complete());
    const txHash = yield* Effect.promise(() => signed.submit());
    emulator.awaitBlock(2);
    const utxo = (yield* Effect.promise(() => lucid.utxosAt(address))).find(
      (u) => u.txHash === txHash && u.scriptRef,
    );
    if (!utxo) throw new Error("reference-script UTxO not found after deploy");
    return utxo;
  });

/**
 * Deploy the instance's two large validators as reference scripts — the
 * dispatcher (~7.5KB) and voting (~10KB) no longer fit inline together.
 */
export const deployGovRefs = (
  ctx: DeployContext,
  instance: GovernanceInstance,
): Effect.Effect<GovScriptRefs> =>
  Effect.gen(function* () {
    const dispatcher = yield* deployScriptRef(
      ctx,
      instance.dispatcherValidator.spend,
    );
    const voting = yield* deployScriptRef(ctx, instance.votingValidator);
    return { dispatcher, voting };
  });
