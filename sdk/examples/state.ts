/**
 * Example State Persistence
 *
 * Saves token suffixes to state.json between example runs so each script
 * can find its on-chain identity without relying on stale UTxO references.
 *
 * Why token suffixes, not UTxO references?
 *   A UTxO reference (txHash + outputIndex) is invalidated every time the UTxO
 *   is spent — which happens on every update, join, or withdraw. A CIP-68 token
 *   suffix is derived from the original mint OutRef and never changes, regardless
 *   of how many transactions are built on top of it. The SDK resolves the current
 *   UTxO internally via lucid.utxoByUnit(policyId + prefix + suffix) on each call.
 *
 * Usage:
 *   loadState()                        — read state.json (empty object if missing)
 *   saveState({ groupTokenSuffix })    — merge into state.json
 *   clearState(["groupTokenSuffix"])   — remove specific keys
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// State lives in examples/ not dist/ — dist/ is wiped on every build.
const STATE_FILE = path.join(__dirname, "..", "state.json");

export type ScriptRefOutRef = { txHash: string; outputIndex: number };

export type ExampleState = {
  // Protocol settings (P5). Written once by initialize-settings; every group/treasury
  // script derives from this settings policy. The seed OutRef is kept so the policy can
  // be re-derived deterministically (deriveSettings) on any later run.
  settingsPolicy?: string;
  settingsSeed?: ScriptRefOutRef;

  // Validator fingerprints — written at first mint, compared on every subsequent run.
  // If these change it means the on-chain contracts were upgraded and stored token
  // suffixes now point to UTxOs locked under the old (unreachable) validator.
  accountPolicyId?: string;
  groupPolicyId?: string;

  accountTokenSuffix?: string; // USER1
  adminAccountTokenSuffix?: string; // ADMIN
  user2AccountTokenSuffix?: string; // USER2
  groupTokenSuffix?: string;
  groupStartTime?: number; // POSIX ms — from group datum at creation
  groupIntervalLength?: number; // ms
  groupNumRounds?: number;

  // Reference script UTxOs — deployed once by deploy-scripts.ts, used by all
  // transactions that would otherwise exceed the 16KB Cardano tx size limit.
  // treasury.mint === treasury.spend CBOR, so one UTxO covers both handlers.
  // Same for group.mint === group.spend. The treasury split (2026-07-04) adds
  // the four withdraw-zero family stake validators, each deployed as its own ref.
  scriptRefTreasury?: ScriptRefOutRef;
  scriptRefGroup?: ScriptRefOutRef;
  scriptRefTreasuryRounds?: ScriptRefOutRef;
  scriptRefTreasuryLifecycle?: ScriptRefOutRef;
  scriptRefTreasuryRecovery?: ScriptRefOutRef;
  scriptRefTreasuryReserve?: ScriptRefOutRef;

  // Escrow (standalone family — @tx-meta/dcu-kit/escrow). The permanent
  // identity of the last escrow created by escrow-create.ts.
  escrowStateTokenName?: string;
};

export type AccountSuffixKey =
  "accountTokenSuffix" | "adminAccountTokenSuffix" | "user2AccountTokenSuffix";

/** Maps ACTIVE_WALLET value to its state.json key for the account token suffix. */
export function accountSuffixKey(activeWallet: string): AccountSuffixKey {
  if (activeWallet === "ADMIN") return "adminAccountTokenSuffix";
  if (activeWallet === "USER2") return "user2AccountTokenSuffix";
  return "accountTokenSuffix";
}

/** Returns current slot index and ms until the next slot boundary. */
export function computeSlotInfo(
  state: ExampleState,
): { currentSlot: number; msUntilNextSlot: number } | null {
  if (
    !state.groupStartTime ||
    !state.groupIntervalLength ||
    !state.groupNumRounds
  )
    return null;
  const elapsed = Date.now() - state.groupStartTime;
  const currentSlot =
    Math.floor(elapsed / state.groupIntervalLength) % state.groupNumRounds;
  const slotElapsed = elapsed % state.groupIntervalLength;
  const msUntilNextSlot = state.groupIntervalLength - slotElapsed;
  return { currentSlot, msUntilNextSlot };
}

/** Prints the slot schedule: current slot, and when each member slot opens next. */
export function printSlotSchedule(
  state: ExampleState,
  memberSlots: number[] = [],
): void {
  const info = computeSlotInfo(state);
  if (!info) {
    console.log("No timing info in state.json — run create-group first.");
    return;
  }
  const { currentSlot, msUntilNextSlot } = info;
  const secsLeft = Math.ceil(msUntilNextSlot / 1000);
  console.log(`\n--- Slot schedule ---`);
  console.log(`Current slot:      ${currentSlot}`);
  console.log(`Next slot in:      ${secsLeft}s`);
  for (const slot of memberSlots) {
    const slotsAway =
      (slot - currentSlot + state.groupNumRounds!) % state.groupNumRounds!;
    const msAway =
      slotsAway === 0
        ? 0
        : slotsAway * state.groupIntervalLength! -
          (state.groupIntervalLength! - msUntilNextSlot);
    const secsAway = Math.ceil(msAway / 1000);
    const label = slotsAway === 0 ? "NOW" : `in ${secsAway}s`;
    console.log(`Slot ${slot} window:    ${label}`);
  }
  console.log(`---------------------\n`);
}

/**
 * Compares the current SDK's policy IDs against what was recorded in state.json
 * the last time tokens were minted. A mismatch means the on-chain contracts were
 * upgraded — stored token suffixes now point to UTxOs under the old validator and
 * any transaction that tries to spend them will be rejected on-chain.
 *
 * Call this at the top of every live-network script, right after isEmulator guard.
 */
export function checkValidatorStaleness(current: {
  accountPolicyId?: string;
  groupPolicyId?: string;
}): void {
  const state = loadState();
  const stale: string[] = [];

  if (
    current.accountPolicyId &&
    state.accountPolicyId &&
    state.accountPolicyId !== current.accountPolicyId
  ) {
    stale.push(
      `  accountPolicyId:\n    stored:  ${state.accountPolicyId}\n    current: ${current.accountPolicyId}`,
    );
  }
  if (
    current.groupPolicyId &&
    state.groupPolicyId &&
    state.groupPolicyId !== current.groupPolicyId
  ) {
    stale.push(
      `  groupPolicyId:\n    stored:  ${state.groupPolicyId}\n    current: ${current.groupPolicyId}`,
    );
  }

  if (stale.length > 0) {
    console.error(
      "\nERROR: Validator hashes have changed since state.json was last written.",
    );
    console.error(
      "Stored token suffixes point to UTxOs locked under the old (unreachable) validator.",
    );
    for (const line of stale) console.error(line);
    console.error(
      "Run 'pnpm run reset-state' to clear stale state, then recreate the group.\n",
    );
    process.exit(1);
  }
}

export function loadState(): ExampleState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveState(updates: Partial<ExampleState>): void {
  const next = { ...loadState(), ...updates };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  console.log("State saved:", JSON.stringify(updates));
}

export function clearState(keys: (keyof ExampleState)[]): void {
  const current = loadState();
  for (const k of keys) delete current[k];
  fs.writeFileSync(STATE_FILE, JSON.stringify(current, null, 2));
  console.log("State cleared:", keys.join(", "));
}
