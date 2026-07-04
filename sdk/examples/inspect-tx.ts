/**
 * Inspect Transaction — post-mortem performance metrics for any submitted tx.
 *
 * Queries Blockfrost for fee, size, and per-redeemer ExUnit consumption
 * (CPU steps + memory units), then prints a formatted budget breakdown with
 * % bars relative to Cardano's protocol limits.
 *
 * Use this immediately after any example script runs on Preprod to profile
 * validator performance. The most important operation to watch is
 * distributePayout — its budget scales with member count.
 *
 * Usage:
 *   TX_HASH=<txhash> pnpm run inspect-tx
 *
 * Requirements:
 *   BLOCKFROST_KEY (or MAESTRO_API_KEY) in .env
 *   NETWORK=Preprod (or Mainnet / Preview)
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Protocol limits (Babbage / Conway era) ───────────────────────────────────
const PROTOCOL = {
  TX_SIZE_MAX: 16_384, // bytes
  CPU_MAX: 10_000_000_000, // steps per transaction
  MEM_MAX: 14_000_000, // units per transaction
  // ExUnit fee pricing (current protocol parameters)
  PRICE_MEM: 0.0577, // lovelace per memory unit
  PRICE_CPU: 0.0000721, // lovelace per CPU step
} as const;

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const RED = "\x1b[31m";
const YEL = "\x1b[33m";
const GRN = "\x1b[32m";
const DIM = "\x1b[2m";
const RST = "\x1b[0m";
const BLD = "\x1b[1m";

function colour(pct: number, text: string): string {
  if (pct > 80) return `${RED}${text}${RST}`;
  if (pct > 50) return `${YEL}${text}${RST}`;
  return `${GRN}${text}${RST}`;
}

function bar(pct: number, width = 28): string {
  const capped = Math.min(pct, 100);
  const filled = Math.round((capped / 100) * width);
  return colour(pct, "█".repeat(filled) + "░".repeat(width - filled));
}

function pctStr(pct: number, pad = 5): string {
  const s = pct.toFixed(1).padStart(pad) + "%";
  return colour(pct, s);
}

function ada(lovelace: bigint | number): string {
  return (Number(lovelace) / 1_000_000).toFixed(4) + " ADA";
}

function commas(n: number | bigint): string {
  return Number(n).toLocaleString();
}

// ─── Load validator hash → name map from plutus.json ─────────────────────────
const PLUTUS_PATH = resolve(process.cwd(), "../src/core/plutus.json");
const hashToName: Record<string, string> = {};
try {
  const bp = JSON.parse(readFileSync(PLUTUS_PATH, "utf-8"));
  for (const v of bp.validators as Array<{ title: string; hash: string }>) {
    if (!hashToName[v.hash]) {
      // Short name: second-to-last segment of dotted title
      const parts = v.title.split(".");
      hashToName[v.hash] = parts[parts.length - 2] ?? v.title;
    }
  }
} catch {
  // Non-fatal — hashes will display without friendly names
}

// ─── Blockfrost / Maestro REST client ─────────────────────────────────────────
interface BlockfrostTx {
  hash: string;
  block: string;
  block_height: number;
  slot: number;
  fees: string;
  size: number;
  valid_contract: boolean;
  redeemer_count: number;
}

interface BlockfrostRedeemer {
  tx_index: number;
  purpose: string; // "spend" | "mint" | "cert" | "reward"
  script_hash: string;
  unit_mem: string;
  unit_steps: string;
  fee: string;
}

async function blockfrostGet<T>(
  path: string,
  projectId: string,
  baseUrl: string,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  const res = await fetch(url, {
    headers: { project_id: projectId },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Blockfrost ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const txHash = process.env.TX_HASH;
  if (!txHash) {
    console.error("Usage: TX_HASH=<txhash> pnpm run inspect-tx");
    process.exit(1);
  }

  const network = process.env.NETWORK ?? "";
  const blockfrostKey = process.env.BLOCKFROST_KEY;
  const baseUrl =
    process.env.BLOCKFROST_URL ??
    (network === "Mainnet"
      ? "https://cardano-mainnet.blockfrost.io/api/v0"
      : network === "Preview"
        ? "https://cardano-preview.blockfrost.io/api/v0"
        : "https://cardano-preprod.blockfrost.io/api/v0");

  if (!blockfrostKey) {
    console.error("BLOCKFROST_KEY not set in .env — required for inspect-tx.");
    process.exit(1);
  }

  if (!["Preprod", "Preview", "Mainnet"].includes(network)) {
    console.error(
      `NETWORK=${network || "(unset)"} — inspect-tx requires a live network (Preprod / Preview / Mainnet).`,
    );
    process.exit(1);
  }

  const RULE = "─".repeat(72);
  const DOUBLE = "═".repeat(72);

  console.log(`\n${BLD}Transaction Inspector${RST}  ${DIM}${network}${RST}`);
  console.log(DOUBLE);

  // Fetch tx info and redeemers in parallel
  let tx: BlockfrostTx;
  let redeemers: BlockfrostRedeemer[];
  try {
    [tx, redeemers] = await Promise.all([
      blockfrostGet<BlockfrostTx>(`txs/${txHash}`, blockfrostKey, baseUrl),
      blockfrostGet<BlockfrostRedeemer[]>(
        `txs/${txHash}/redeemers`,
        blockfrostKey,
        baseUrl,
      ),
    ]);
  } catch (e) {
    console.error(`\nFailed to fetch transaction: ${(e as Error).message}`);
    console.error("Is the tx hash correct and already confirmed on-chain?");
    process.exit(1);
  }

  // ─── Transaction header ────────────────────────────────────────────────────
  const sizePct = (tx.size / PROTOCOL.TX_SIZE_MAX) * 100;
  const subdomain = network === "Mainnet" ? "" : `${network.toLowerCase()}.`;
  const explorerUrl = `https://${subdomain}cexplorer.io/tx/${txHash}`;

  console.log(`\n  Hash    : ${DIM}${tx.hash}${RST}`);
  console.log(
    `  Block   : ${commas(tx.block_height)}  Slot: ${commas(tx.slot)}`,
  );
  console.log(
    `  Fee     : ${BLD}${ada(BigInt(tx.fees))}${RST}  ${DIM}(${commas(BigInt(tx.fees))} lovelace)${RST}`,
  );
  console.log(
    `  Size    : ${commas(tx.size)} / ${commas(PROTOCOL.TX_SIZE_MAX)} bytes  ${bar(sizePct, 20)} ${pctStr(sizePct)}`,
  );
  const validity = tx.valid_contract
    ? `${GRN}✓ valid${RST}`
    : `${RED}✗ invalid (phase-2 failure)${RST}`;
  console.log(`  Scripts : ${validity}`);
  console.log(`  Explorer: ${DIM}${explorerUrl}${RST}`);

  if (!tx.valid_contract) {
    console.log(
      `\n  ${RED}Phase-2 script validation failed — ExUnit data reflects the failed evaluation.${RST}`,
    );
  }

  if (redeemers.length === 0) {
    console.log(
      `\n${DIM}  No script redeemers — pure key-hash transaction.${RST}`,
    );
    console.log(`\n${DOUBLE}\n`);
    return;
  }

  // ─── Per-redeemer breakdown ────────────────────────────────────────────────
  console.log(`\n${RULE}`);
  console.log(
    `${BLD} Redeemers  (${redeemers.length} script execution${redeemers.length !== 1 ? "s" : ""})${RST}`,
  );
  console.log(RULE);

  let totalCpu = 0;
  let totalMem = 0;
  let totalScriptFees = 0n;

  // Group consecutive redeemers by script_hash for compact display
  type Group = {
    purpose: string;
    hash: string;
    name: string;
    entries: BlockfrostRedeemer[];
  };
  const groups: Group[] = [];
  for (const r of redeemers) {
    const last = groups[groups.length - 1];
    if (last && last.hash === r.script_hash && last.purpose === r.purpose) {
      last.entries.push(r);
    } else {
      groups.push({
        purpose: r.purpose,
        hash: r.script_hash,
        name: hashToName[r.script_hash] ?? r.script_hash.slice(0, 12) + "...",
        entries: [r],
      });
    }
  }

  for (const g of groups) {
    const groupCpu = g.entries.reduce((s, e) => s + Number(e.unit_steps), 0);
    const groupMem = g.entries.reduce((s, e) => s + Number(e.unit_mem), 0);
    const groupFee = g.entries.reduce((s, e) => s + BigInt(e.fee), 0n);
    const cpuPct = (groupCpu / PROTOCOL.CPU_MAX) * 100;
    const memPct = (groupMem / PROTOCOL.MEM_MAX) * 100;
    const count = g.entries.length;

    totalCpu += groupCpu;
    totalMem += groupMem;
    totalScriptFees += groupFee;

    const countLabel = count > 1 ? ` ${DIM}× ${count} executions${RST}` : "";
    console.log(
      `\n  ${BLD}${g.purpose.toUpperCase()}${RST}  ${GRN}${g.name}${RST}${countLabel}`,
    );
    console.log(`  ${DIM}${g.hash}${RST}`);
    console.log(
      `  CPU  ${commas(groupCpu).padStart(15)} / ${commas(PROTOCOL.CPU_MAX)} steps  ${bar(cpuPct)} ${pctStr(cpuPct)}`,
    );
    console.log(
      `  Mem  ${commas(groupMem).padStart(15)} / ${commas(PROTOCOL.MEM_MAX)} units  ${bar(memPct)} ${pctStr(memPct)}`,
    );
    console.log(
      `  Fee  ${ada(groupFee)}  ${DIM}(${commas(groupFee)} lovelace)${RST}`,
    );

    // Warn if close to limit
    if (cpuPct > 70 || memPct > 70) {
      console.log(
        `  ${YEL}⚠  Approaching protocol limits — consider optimising this validator${RST}`,
      );
    }
    if (cpuPct > 90 || memPct > 90) {
      console.log(
        `  ${RED}✗  CRITICAL: budget nearly exhausted — larger inputs may fail${RST}`,
      );
    }
  }

  // ─── Budget totals ─────────────────────────────────────────────────────────
  const totalCpuPct = (totalCpu / PROTOCOL.CPU_MAX) * 100;
  const totalMemPct = (totalMem / PROTOCOL.MEM_MAX) * 100;
  const txFee = BigInt(tx.fees);
  const networkFee = txFee - totalScriptFees;

  console.log(`\n${RULE}`);
  console.log(
    `${BLD} Budget totals${RST}  ${DIM}(sum across all redeemers)${RST}`,
  );
  console.log(RULE);
  console.log(
    `  CPU  ${commas(totalCpu).padStart(15)} / ${commas(PROTOCOL.CPU_MAX)} steps  ${bar(totalCpuPct)} ${pctStr(totalCpuPct)}`,
  );
  console.log(
    `  Mem  ${commas(totalMem).padStart(15)} / ${commas(PROTOCOL.MEM_MAX)} units  ${bar(totalMemPct)} ${pctStr(totalMemPct)}`,
  );

  // ─── Fee breakdown ─────────────────────────────────────────────────────────
  console.log(`\n${RULE}`);
  console.log(`${BLD} Fee breakdown${RST}`);
  console.log(RULE);
  console.log(
    `  Network fee (size)  : ${ada(networkFee).padEnd(14)} ${DIM}fixed + (${commas(tx.size)} bytes × fee/byte)${RST}`,
  );
  console.log(
    `  Script fees (ExUnits): ${ada(totalScriptFees).padEnd(14)} ${DIM}(mem × 0.0577) + (cpu × 0.0000721)${RST}`,
  );
  console.log(`  ${BLD}Total fee           : ${ada(txFee)}${RST}`);

  // ─── Remaining headroom ────────────────────────────────────────────────────
  const cpuRemaining = PROTOCOL.CPU_MAX - totalCpu;
  const memRemaining = PROTOCOL.MEM_MAX - totalMem;
  const sizeRemaining = PROTOCOL.TX_SIZE_MAX - tx.size;

  console.log(`\n${RULE}`);
  console.log(`${BLD} Remaining headroom${RST}`);
  console.log(RULE);
  console.log(
    `  CPU  : ${GRN}${commas(cpuRemaining)} steps remaining${RST}  ${DIM}(${(100 - totalCpuPct).toFixed(1)}% free)${RST}`,
  );
  console.log(
    `  Mem  : ${GRN}${commas(memRemaining)} units remaining${RST}  ${DIM}(${(100 - totalMemPct).toFixed(1)}% free)${RST}`,
  );
  console.log(
    `  Size : ${GRN}${commas(sizeRemaining)} bytes remaining${RST}  ${DIM}(${(100 - sizePct).toFixed(1)}% free)${RST}`,
  );

  // Scale measurement for distribute (WITHDRAW-ZERO model).
  //
  // With withdraw-zero, the member-count-scaling cost lives in the SINGLE treasury
  // REWARD (withdrawal) redeemer — the per-member treasury SPEND redeemers are now O(1)
  // coupling checks. That reward redeemer runs `count_active_members`, which is O(N²), so
  // its cost grows super-linearly: DO NOT linearly extrapolate from one tx. To find the
  // real max_members cap, run distribute at 2–3 increasing group sizes and watch where the
  // reward redeemer's Mem/CPU crosses ~80–90%. The member count of THIS tx ≈ the number of
  // treasury spend redeemers.
  const treasurySpends = redeemers.filter(
    (r) => hashToName[r.script_hash] === "treasury" && r.purpose === "spend",
  );
  const treasuryReward = redeemers.find(
    (r) => hashToName[r.script_hash] === "treasury" && r.purpose === "reward",
  );
  if (treasuryReward) {
    const rMem = Number(treasuryReward.unit_mem);
    const rCpu = Number(treasuryReward.unit_steps);
    const rMemPct = (rMem / PROTOCOL.MEM_MAX) * 100;
    const rCpuPct = (rCpu / PROTOCOL.CPU_MAX) * 100;
    console.log(
      `\n  ${BLD}Scale measurement (withdraw-zero):${RST}  members in this tx ≈ ${GRN}${treasurySpends.length}${RST}`,
    );
    console.log(
      `  The single REWARD (withdraw) redeemer carries the O(N²) round logic:`,
    );
    console.log(
      `  Mem  ${commas(rMem).padStart(15)} / ${commas(PROTOCOL.MEM_MAX)}  ${bar(rMemPct)} ${pctStr(rMemPct)}`,
    );
    console.log(
      `  CPU  ${commas(rCpu).padStart(15)} / ${commas(PROTOCOL.CPU_MAX)}  ${bar(rCpuPct)} ${pctStr(rCpuPct)}`,
    );
    console.log(
      `  ${DIM}Cost is super-linear (O(N²)) — run 2–3 sizes to locate the real max_members cap;${RST}`,
    );
    console.log(
      `  ${DIM}pin the on-chain cap (group.ak max_group_members) safely below the crossover.${RST}`,
    );
  }

  console.log(`\n${DOUBLE}\n`);
}

main().catch((e) => {
  console.error("Error:", (e as Error).message ?? e);
  process.exit(1);
});
