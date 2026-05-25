/**
 * State Reset Utility
 *
 * Clears specific keys from state.json or wipes the entire file.
 *
 * Usage:
 *   pnpm run reset-state              — clears all keys (full reset)
 *   pnpm run reset-state account      — clears all account token suffixes
 *   pnpm run reset-state group        — clears group token suffix + timing
 *   pnpm run reset-state account group — clear multiple groups
 */

import fs from "fs";
import path from "path";

const STATE_FILE = path.join(process.cwd(), "state.json");

const GROUPS: Record<string, string[]> = {
    account: ["accountPolicyId", "accountTokenSuffix", "adminAccountTokenSuffix", "user2AccountTokenSuffix"],
    group:   ["groupPolicyId", "groupTokenSuffix", "groupStartTime", "groupIntervalLength", "groupNumIntervals"],
};

const ALL_KEYS = Object.values(GROUPS).flat();

function loadState(): Record<string, unknown> {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    } catch {
        return {};
    }
}

function removeKeys(keys: string[]): void {
    const state = loadState();
    const removed: string[] = [];
    for (const k of keys) {
        if (k in state) {
            delete state[k];
            removed.push(k);
        }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    if (removed.length > 0) {
        console.log("Cleared:", removed.join(", "));
    } else {
        console.log("Nothing to clear (keys not present in state.json).");
    }
}

const args = process.argv.slice(2).filter((a) => a !== "--");

if (args.length === 0) {
    const current = loadState();
    if (Object.keys(current).length === 0) {
        console.log("state.json is already empty.");
    } else {
        removeKeys(ALL_KEYS);
        console.log("Full reset complete.");
    }
} else {
    const keysToRemove: string[] = [];
    for (const arg of args) {
        const group = GROUPS[arg.toLowerCase()];
        if (!group) {
            console.error(`Unknown group: "${arg}". Valid options: ${Object.keys(GROUPS).join(", ")}`);
            process.exit(1);
        }
        keysToRemove.push(...group);
    }
    removeKeys(keysToRemove);
}
