/**
 * Example Context Setup
 *
 * Reads provider and wallet configuration from environment variables (.env).
 * Controls which network/provider the examples use without changing code.
 *
 * Usage in .env:
 *   BLOCKFROST_KEY=preprod...   → Blockfrost on Preprod
 *   MAESTRO_API_KEY=...         → Maestro on Preprod
 *   (neither set)               → Emulator (local, no network required)
 *
 * Wallet seeds:
 *   USER1_SEED="..."   → primary user wallet (required for live network)
 *   ADMIN_SEED="..."   → admin wallet (required for live network group operations)
 */

import "dotenv/config";
import {
  Lucid,
  Blockfrost,
  Maestro,
  Emulator,
  PROTOCOL_PARAMETERS_DEFAULT,
  generateEmulatorAccount,
  LucidEvolution,
} from "@lucid-evolution/lucid";

export type ExampleContext = {
  lucid: LucidEvolution;
  isEmulator: boolean;
};

const LIVE_NETWORKS = ["Preprod", "Mainnet", "Preview"] as const;
type LiveNetwork = (typeof LIVE_NETWORKS)[number];

function liveNetwork(raw: string | undefined): LiveNetwork | null {
  return (LIVE_NETWORKS as readonly string[]).includes(raw ?? "")
    ? (raw as LiveNetwork)
    : null;
}

export async function makeLucid(): Promise<ExampleContext> {
  const blockfrostKey = process.env.BLOCKFROST_KEY;
  const maestroKey = process.env.MAESTRO_API_KEY;
  const network = liveNetwork(process.env.NETWORK);

  // --- Blockfrost ---
  if (blockfrostKey && network) {
    const url =
      process.env.BLOCKFROST_URL ??
      "https://cardano-preprod.blockfrost.io/api/v0";
    const lucid = await Lucid(new Blockfrost(url, blockfrostKey), network);
    const seed = process.env.USER1_SEED;
    if (!seed)
      throw new Error("USER1_SEED is required when BLOCKFROST_KEY is set");
    lucid.selectWallet.fromSeed(seed);
    console.log(`Provider: Blockfrost (${network})`);
    return { lucid, isEmulator: false };
  }

  // --- Maestro ---
  if (maestroKey && network) {
    const lucid = await Lucid(
      new Maestro({ network, apiKey: maestroKey, turboSubmit: false }),
      network,
    );
    const seed = process.env.USER1_SEED;
    if (!seed)
      throw new Error("USER1_SEED is required when MAESTRO_API_KEY is set");
    lucid.selectWallet.fromSeed(seed);
    console.log(`Provider: Maestro (${network})`);
    return { lucid, isEmulator: false };
  }

  // --- Emulator (default, or when NETWORK=Emulator / not a live network) ---
  const user = generateEmulatorAccount({ lovelace: 100_000_000n });
  const emulator = new Emulator([user], { ...PROTOCOL_PARAMETERS_DEFAULT });
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(user.seedPhrase);
  console.log("Provider: Emulator");
  console.log("Wallet address:", user.address);
  return { lucid, isEmulator: true };
}

export async function logWalletInfo(
  lucid: LucidEvolution,
  label: string,
): Promise<void> {
  const address = await lucid.wallet().address();
  const utxos = await lucid.wallet().getUtxos();
  const spendable = utxos.filter((u) => !u.scriptRef);
  const withRefs = utxos.filter((u) => u.scriptRef);
  const total = utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
  const liquid = spendable.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
  const network = process.env.NETWORK ?? "Preprod";
  const subdomain = network === "Mainnet" ? "" : `${network.toLowerCase()}.`;
  console.log(
    `Wallet [${label}]  ${(Number(total) / 1e6).toFixed(2)} ADA total  |  ${(Number(liquid) / 1e6).toFixed(2)} ADA spendable`,
  );
  if (withRefs.length > 0)
    console.log(
      `  ⚠  ${withRefs.length} UTxO(s) hold reference scripts — excluded from coin selection`,
    );
  console.log(`Address: ${address}`);
  console.log(`Explorer: https://${subdomain}cexplorer.io/address/${address}`);
}

export function cexplorerTxUrl(txHash: string): string {
  const network = process.env.NETWORK ?? "Preprod";
  const subdomain = network === "Mainnet" ? "" : `${network.toLowerCase()}.`;
  return `https://${subdomain}cexplorer.io/tx/${txHash}`;
}

/**
 * Extracts and prints the real error from an Effect FiberFailure.
 *
 * Effect.runPromise (used by unsafeRun) wraps failures in a FiberFailure.
 * Effect 3.x stores the typed failure at cause.failure (not cause.error).
 */
export function logError(e: unknown): void {
  const fiberFailureSymbol = Symbol.for("effect/Runtime/FiberFailure");
  const causeSymbol = Symbol.for("effect/Runtime/FiberFailure/Cause");
  const isFiberFailure =
    e != null && typeof e === "object" && fiberFailureSymbol in e;

  let inner: unknown = e;

  if (isFiberFailure) {
    // Effect 3.x stores the Cause under a Symbol key, not a string property.
    const cause = (e as any)[causeSymbol];
    // Cause<E> variants: "Fail" has .failure, "Die" has .defect.
    if (cause?._tag === "Fail") inner = cause.failure ?? cause.error;
    else if (cause?._tag === "Die") inner = cause.defect;
  }

  if (inner != null && typeof inner === "object" && "_tag" in inner) {
    const parts: string[] = [`[${(inner as any)._tag}]`];
    for (const [k, v] of Object.entries(inner as object)) {
      if (k === "_tag") continue;
      parts.push(
        `  ${k}: ${typeof v === "object" ? JSON.stringify(v, null, 2) : v}`,
      );
    }
    // Also surface non-enumerable .message and .cause (common on Error subclasses)
    const msg = (inner as any).message;
    const cause = (inner as any).cause;
    if (msg && !Object.prototype.hasOwnProperty.call(inner, "message"))
      parts.push(`  message: ${msg}`);
    if (cause !== undefined)
      parts.push(
        `  cause: ${typeof cause === "object" ? JSON.stringify(cause, null, 2) : cause}`,
      );
    console.error(parts.join("\n"));
  } else if (inner instanceof Error) {
    console.error("Error:", inner.message);
    if (inner.stack) console.error(inner.stack);
  } else {
    try {
      console.error("Error:", JSON.stringify(inner ?? e, null, 2));
    } catch {
      console.error("Error:", String(inner ?? e));
    }
  }
}
