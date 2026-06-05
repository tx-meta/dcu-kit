/**
 * Show Script Sizes — static validator analysis, no network required.
 *
 * Reads plutus.json and reports every compiled validator's CBOR size,
 * script hash, and proximity to Cardano's 16 KB transaction size limit.
 * Also shows which protocol operations require reference scripts because
 * their combined inline size exceeds that limit.
 *
 * Run this after every `aiken build` to catch unexpected size growth.
 *
 * Usage:
 *   pnpm run show-script-sizes
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Protocol limits ──────────────────────────────────────────────────────────
const TX_SIZE_LIMIT = 16_384; // bytes — hard ceiling for any Cardano transaction

// ─── ANSI colour helpers ──────────────────────────────────────────────────────
const RED = "\x1b[31m";
const YEL = "\x1b[33m";
const GRN = "\x1b[32m";
const DIM = "\x1b[2m";
const RST = "\x1b[0m";
const BLD = "\x1b[1m";

function colour(pct: number, text: string): string {
  if (pct > 100) return `${RED}${text}${RST}`;
  if (pct > 70) return `${YEL}${text}${RST}`;
  if (pct > 40) return `${GRN}${text}${RST}`;
  return `${DIM}${text}${RST}`;
}

function bar(pct: number, width = 28): string {
  const capped = Math.min(pct, 100);
  const filled = Math.round((capped / 100) * width);
  const empty = width - filled;
  const b = "█".repeat(filled) + "░".repeat(empty);
  return colour(pct, b);
}

function pctStr(pct: number): string {
  const s = pct.toFixed(1).padStart(5) + "%";
  return colour(pct, s);
}

function fmt(bytes: number): string {
  return `${bytes.toLocaleString()} bytes (${(bytes / 1024).toFixed(1)} KB)`;
}

// ─── Load blueprint ───────────────────────────────────────────────────────────
interface BlueprintValidator {
  title: string;
  compiledCode: string;
  hash: string;
}
interface Blueprint {
  validators: BlueprintValidator[];
}

const PLUTUS_PATH = resolve(process.cwd(), "../src/core/plutus.json");
let blueprint: Blueprint;
try {
  blueprint = JSON.parse(readFileSync(PLUTUS_PATH, "utf-8"));
} catch {
  console.error(`Could not read plutus.json at ${PLUTUS_PATH}`);
  console.error("Run 'aiken build' from the onchain/ directory first.");
  process.exit(1);
}

// Deduplicate by hash — mint/spend/else share the same compiled code and hash.
const seen = new Set<string>();
const unique: Array<{ name: string; bytes: number; hash: string }> = [];

for (const v of blueprint.validators) {
  if (seen.has(v.hash)) continue;
  seen.add(v.hash);

  // Short display name: last two parts of dotted title
  const parts = v.title.split(".");
  const name = parts[parts.length - 2] ?? v.title;

  unique.push({
    name,
    bytes: v.compiledCode.length / 2,
    hash: v.hash,
  });
}

// Known validator index for combination table
const byName = Object.fromEntries(unique.map((v) => [v.name, v]));
const account = byName["account"];
const group = byName["group_validator"] ?? byName["group"];
const treasury = byName["treasury"];
const alwaysFails = byName["always_fails"];

// ─── Output ───────────────────────────────────────────────────────────────────
const RULE = "─".repeat(72);
const DOUBLE = "═".repeat(72);

console.log(
  `\n${BLD}DCU Validator Script Sizes${RST}  ${DIM}(Cardano tx limit: 16,384 bytes)${RST}`,
);
console.log(DOUBLE);

// Per-validator table
const nameWidth = Math.max(...unique.map((v) => v.name.length), 12);
for (const v of unique) {
  const pct = (v.bytes / TX_SIZE_LIMIT) * 100;
  const nameCol = v.name.padEnd(nameWidth);
  const sizeCol = fmt(v.bytes).padEnd(26);
  console.log(
    `  ${BLD}${nameCol}${RST}  ${sizeCol}  ${bar(pct)} ${pctStr(pct)}`,
  );
}

console.log(
  `\n  ${"Validator".padEnd(nameWidth)}  ${"Hash (script identity)".padEnd(26)}`,
);
console.log(`  ${RULE.slice(0, nameWidth + 30)}`);
for (const v of unique) {
  console.log(`  ${v.name.padEnd(nameWidth)}  ${DIM}${v.hash}${RST}`);
}

// ─── Combinations ─────────────────────────────────────────────────────────────
console.log(`\n${RULE}`);
console.log(`${BLD} Operations × inline script cost${RST}`);
console.log(`${RULE}`);
console.log(
  `${DIM} (inline = script bytes included in the tx body itself)${RST}\n`,
);

type Row = { op: string; bytes: number; note: string };
const rows: Row[] = [];

if (account)
  rows.push({
    op: "createAccount / closeAccount / burnAccount",
    bytes: account.bytes,
    note: "account only",
  });

if (group)
  rows.push({
    op: "createGroup / updateGroup / closeGroup / startGroup",
    bytes: group.bytes,
    note: "group only",
  });

if (treasury)
  rows.push({
    op: "contribute / updatePayout / extendGrace / claimPenalty",
    bytes: treasury.bytes,
    note: "treasury only  (group is reference input — not spent)",
  });

if (group && treasury) {
  const combined = group.bytes + treasury.bytes;
  rows.push({
    op: "joinGroup / exitGroup / distributePayout / nextCycle",
    bytes: combined,
    note: `group + treasury = ${fmt(combined)}`,
  });
}

const opWidth = Math.max(...rows.map((r) => r.op.length));

for (const r of rows) {
  const pct = (r.bytes / TX_SIZE_LIMIT) * 100;
  const opCol = r.op.padEnd(opWidth);
  const exceeds = pct > 100;
  const status = exceeds
    ? `${RED}✗ EXCEEDS LIMIT — reference scripts mandatory${RST}`
    : `${GRN}✓ safe inline${RST}`;
  console.log(`  ${opCol}  ${bar(pct, 16)} ${pctStr(pct)}  ${status}`);
  if (exceeds) {
    console.log(`  ${"".padEnd(opWidth)}  ${DIM}(${r.note})${RST}`);
  }
}

// ─── Reference script savings ─────────────────────────────────────────────────
if (group && treasury) {
  const combined = group.bytes + treasury.bytes;
  console.log(`\n${RULE}`);
  console.log(`${BLD} Reference script savings${RST}`);
  console.log(`${RULE}`);
  console.log(
    `${DIM} When reference scripts are deployed (deploy-scripts.ts), the tx body${RST}`,
  );
  console.log(
    `${DIM} carries a 32-byte pointer instead of the full CBOR. This reduces tx size${RST}`,
  );
  console.log(
    `${DIM} by ${(combined / 1024).toFixed(1)} KB per transaction and enables operations that are impossible inline.${RST}`,
  );
  console.log();
  const saved = combined;
  console.log(
    `  Bytes saved per distributePayout / nextCycle : ${GRN}${saved.toLocaleString()} bytes (${(saved / 1024).toFixed(1)} KB)${RST}`,
  );
  if (alwaysFails) {
    console.log(
      `  Reference holder (always_fails) script size  : ${alwaysFails.bytes} bytes — trivial`,
    );
  }
}

console.log(`\n${DOUBLE}\n`);
