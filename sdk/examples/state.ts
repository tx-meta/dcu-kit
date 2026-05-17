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

export type ExampleState = {
    accountTokenSuffix?:          string; // USER1
    adminAccountTokenSuffix?:     string; // ADMIN
    wallet3AccountTokenSuffix?:   string; // WALLET3
    groupTokenSuffix?:            string;
    groupStartTime?:              number; // POSIX ms — from group datum at creation
    groupIntervalLength?:         number; // ms
    groupNumIntervals?:           number;
};

export type AccountSuffixKey = "accountTokenSuffix" | "adminAccountTokenSuffix" | "wallet3AccountTokenSuffix";

/** Maps ACTIVE_WALLET value to its state.json key for the account token suffix. */
export function accountSuffixKey(activeWallet: string): AccountSuffixKey {
    if (activeWallet === "ADMIN")   return "adminAccountTokenSuffix";
    if (activeWallet === "WALLET3") return "wallet3AccountTokenSuffix";
    return "accountTokenSuffix";
}

/** Returns current slot index and ms until the next slot boundary. */
export function computeSlotInfo(state: ExampleState): { currentSlot: number; msUntilNextSlot: number } | null {
    if (!state.groupStartTime || !state.groupIntervalLength || !state.groupNumIntervals) return null;
    const elapsed    = Date.now() - state.groupStartTime;
    const currentSlot = Math.floor(elapsed / state.groupIntervalLength) % state.groupNumIntervals;
    const slotElapsed = elapsed % state.groupIntervalLength;
    const msUntilNextSlot = state.groupIntervalLength - slotElapsed;
    return { currentSlot, msUntilNextSlot };
}

/** Prints the slot schedule: current slot, and when each member slot opens next. */
export function printSlotSchedule(state: ExampleState, memberSlots: number[] = []): void {
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
        const slotsAway = ((slot - currentSlot) + state.groupNumIntervals!) % state.groupNumIntervals!;
        const msAway    = slotsAway === 0 ? 0 : slotsAway * state.groupIntervalLength! - (state.groupIntervalLength! - msUntilNextSlot);
        const secsAway  = Math.ceil(msAway / 1000);
        const label     = slotsAway === 0 ? "NOW" : `in ${secsAway}s`;
        console.log(`Slot ${slot} window:    ${label}`);
    }
    console.log(`---------------------\n`);
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
