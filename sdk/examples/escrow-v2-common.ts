/**
 * Shared helpers for the escrow v2 / project / pool examples.
 *
 * The v2 generation lives beside v1 (versioned, never replacing it): new
 * escrows use @tx-meta/dcu-kit/escrow/v2 while live v1 escrows keep finishing
 * on the v1 hash. These helpers cover what every v2 script needs — wallet
 * lookups by .env name, milestone-spec parsing, and the escrow v2 reference
 * script (the 11 KB v2 script must ride as a reference input on pool
 * allocations, and deploying it once keeps every other tx small too).
 */

import {
  LucidEvolution,
  UTxO,
  walletFromSeed,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import { loadState } from "./state.js";

export const exampleNetwork = () =>
  process.env.NETWORK === "Mainnet"
    ? ("Mainnet" as const)
    : ("Preprod" as const);

/** Resolves a .env wallet name (ADMIN/USER1/USER2) to its seed phrase. */
export function envWalletSeed(name: string): string {
  const seed = process.env[`${name.toUpperCase()}_SEED`];
  if (!seed) throw new Error(`${name.toUpperCase()}_SEED not found in .env`);
  return seed;
}

/** Full (base) address of a .env wallet — payouts must never be enterprise. */
export function envWalletAddress(name: string): string {
  return walletFromSeed(envWalletSeed(name), { network: exampleNetwork() })
    .address;
}

/** Raw payment key of a .env wallet — for co-signing in one process. */
export function envWalletPaymentKey(name: string): string {
  return walletFromSeed(envWalletSeed(name), { network: exampleNetwork() })
    .paymentKey;
}

/**
 * Accepts either a wallet name (ADMIN/USER1/USER2) or a bech32 address and
 * returns the address — how the examples express "who" for any v2 party.
 */
export function resolvePartyAddress(ref: string): string {
  if (ref.startsWith("addr")) return ref;
  return envWalletAddress(ref);
}

/** The payment key-hash of a wallet name or address (for logs only). */
export function partyKeyHash(ref: string): string {
  return getAddressDetails(resolvePartyAddress(ref)).paymentCredential!.hash;
}

/**
 * Parses a milestone spec: "3000000:+8m,2000000:+30m" — amount in lovelace
 * (or asset units), deadline as +Nm/+Nh/+Nd relative to now or absolute
 * POSIX ms. Deadlines must come out strictly increasing.
 */
export function parseMilestones(
  spec: string,
): { amount: bigint; deadline: bigint }[] {
  const now = Date.now();
  return spec.split(",").map((part) => {
    const [amountRaw, deadlineRaw] = part.trim().split(":");
    if (!amountRaw || !deadlineRaw)
      throw new Error(
        `Bad milestone "${part}" — expected amount:deadline (e.g. 3000000:+8m)`,
      );
    const amount = BigInt(amountRaw);
    let deadline: bigint;
    const rel = deadlineRaw.match(/^\+(\d+)([mhd])$/);
    if (rel) {
      const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]]!;
      deadline = BigInt(now + Number(rel[1]) * unit);
    } else {
      deadline = BigInt(deadlineRaw);
    }
    return { amount, deadline };
  });
}

/** "in 4m20s" — for sweep logs that wait on deadlines. */
export function untilLabel(posixMs: bigint): string {
  const delta = Number(posixMs) - Date.now();
  if (delta <= 0) return "already passed";
  const m = Math.floor(delta / 60_000);
  const s = Math.ceil((delta % 60_000) / 1000);
  return `in ${m}m${s}s`;
}

/**
 * Resolves the escrow v2 reference-script UTxO recorded by escrow-v2-deploy.
 * Pool allocations REQUIRE it (vault + 11 KB escrow inline exceeds the 16 KB
 * tx ceiling); plain v2 endpoints attach the script inline and don't need it.
 */
export async function loadEscrowV2ScriptRef(
  lucid: LucidEvolution,
): Promise<UTxO> {
  const ref = loadState().scriptRefEscrowV2;
  if (!ref)
    throw new Error(
      "No scriptRefEscrowV2 in state.json — run escrow-v2-deploy first.",
    );
  const [utxo] = await lucid.utxosByOutRef([ref]);
  if (!utxo?.scriptRef)
    throw new Error(
      "escrow v2 reference-script UTxO not found on-chain — redeploy with escrow-v2-deploy.",
    );
  return utxo;
}

/** The state token this script should act on: env override, then state.json. */
export function requireToken(
  envKey: string,
  stateValue: string | undefined,
  hint: string,
): string {
  const token = process.env[envKey] ?? stateValue;
  if (!token)
    throw new Error(`No ${envKey} set and nothing in state.json — ${hint}`);
  return token;
}
