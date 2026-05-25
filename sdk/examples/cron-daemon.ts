/**
 * Distribute-Payout Cron Daemon
 *
 * Long-running process that monitors an active ROSCA group and automatically
 * submits `distribute-payout` as soon as each round's time gate opens.
 *
 * Because `distribute-payout` is PERMISSIONLESS, the daemon wallet only needs
 * a small ADA balance for collateral (~5 ADA) and tx fees — it never touches
 * the group's funds. Payouts always go to the borrower's address in the datum.
 *
 * Configuration (environment variables):
 *   ADMIN_SEED="..."             Wallet used to sign and pay fees (collateral).
 *   BLOCKFROST_KEY="preprod..."  Provider key (or MAESTRO_API_KEY).
 *   NETWORK=Preprod              Network to use.
 *   POLL_INTERVAL_SECS=30        How often to check whether a round is open (default 30s).
 *   SUBMIT_COOLDOWN_SECS=120     How long to wait after a successful submit before rechecking.
 *
 * State:
 *   Reads groupTokenSuffix + scriptRefTreasury + scriptRefGroup from state.json.
 *   Run create-group, join-group, and start-group first.
 *
 * Stopping:
 *   Ctrl+C — the daemon exits cleanly after the current poll completes.
 *
 * Typical run:
 *   pnpm run cron-daemon
 */

import "dotenv/config";
import {
    Lucid,
    Blockfrost,
    Maestro,
    LucidEvolution,
    Data,
    UTxO,
} from "@lucid-evolution/lucid";
import { distributePayout, DistributePayoutConfig, groupPolicyId, GroupDatum, assetNameLabels } from "@dcu/sdk";
import { loadState, ExampleState } from "./state.js";
import { logError } from "./context.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS    = Number(process.env.POLL_INTERVAL_SECS   ?? 30)  * 1_000;
const SUBMIT_COOLDOWN_MS  = Number(process.env.SUBMIT_COOLDOWN_SECS ?? 120) * 1_000;
const CLOCK_BUFFER_MS     = 120_000; // 120 s buffer — covers Blockfrost slot lag

type LiveNetwork = "Preprod" | "Mainnet" | "Preview";

const LIVE_NETWORKS = ["Preprod", "Mainnet", "Preview"] as const;

function liveNetwork(raw: string | undefined): LiveNetwork | null {
    return (LIVE_NETWORKS as readonly string[]).includes(raw ?? "") ? (raw as LiveNetwork) : null;
}

// ---------------------------------------------------------------------------
// Lucid setup (live networks only — no emulator)
// ---------------------------------------------------------------------------

async function makeLucid(): Promise<LucidEvolution> {
    const blockfrostKey = process.env.BLOCKFROST_KEY;
    const maestroKey    = process.env.MAESTRO_API_KEY;
    const network       = liveNetwork(process.env.NETWORK);

    if (!network) {
        throw new Error(
            "NETWORK must be set to Preprod, Mainnet, or Preview. " +
            "The cron daemon requires a live network — it cannot run on the emulator."
        );
    }

    const adminSeed = process.env.ADMIN_SEED;
    if (!adminSeed) throw new Error("ADMIN_SEED is required in .env");

    if (blockfrostKey) {
        const url  = process.env.BLOCKFROST_URL ?? "https://cardano-preprod.blockfrost.io/api/v0";
        const lucid = await Lucid(new Blockfrost(url, blockfrostKey), network);
        lucid.selectWallet.fromSeed(adminSeed);
        console.log(`[cron] Provider: Blockfrost (${network})`);
        return lucid;
    }

    if (maestroKey) {
        const lucid = await Lucid(new Maestro({ network, apiKey: maestroKey, turboSubmit: false }), network);
        lucid.selectWallet.fromSeed(adminSeed);
        console.log(`[cron] Provider: Maestro (${network})`);
        return lucid;
    }

    throw new Error("Set BLOCKFROST_KEY or MAESTRO_API_KEY in .env to run the cron daemon.");
}

// ---------------------------------------------------------------------------
// Round readiness check
// ---------------------------------------------------------------------------

type RoundStatus =
    | { ready: true;  roundNumber: bigint; groupDatum: GroupDatum }
    | { ready: false; reason: string };

async function checkRound(lucid: LucidEvolution, groupTokenSuffix: string): Promise<RoundStatus> {
    const groupRefUnit = groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;

    let groupUtxo: UTxO | undefined;
    try {
        groupUtxo = await lucid.utxoByUnit(groupRefUnit);
    } catch (e) {
        return { ready: false, reason: `Failed to query group UTxO: ${e}` };
    }

    if (!groupUtxo) {
        return { ready: false, reason: "Group UTxO not found on-chain. Has the group been created?" };
    }
    if (!groupUtxo.datum) {
        return { ready: false, reason: "Group UTxO has no inline datum." };
    }

    let groupDatum: GroupDatum;
    try {
        groupDatum = Data.from(groupUtxo.datum, GroupDatum);
    } catch (e) {
        return { ready: false, reason: `Failed to decode group datum: ${e}` };
    }

    if (!groupDatum.is_started) {
        return { ready: false, reason: "Group has not been started — run start-group first." };
    }
    if (!groupDatum.is_active) {
        return { ready: false, reason: "Group is inactive (is_active=false)." };
    }

    const roundNumber = groupDatum.last_distributed_round + 1n;

    if (roundNumber >= groupDatum.num_intervals) {
        return {
            ready: false,
            reason: `All ${groupDatum.num_intervals} rounds complete. Group is mature — members can exit.`,
        };
    }

    // Gate: start_time + round * interval_length
    const gateMs = groupDatum.start_time + roundNumber * groupDatum.interval_length;
    const nowMs  = BigInt(Date.now()) - BigInt(CLOCK_BUFFER_MS);

    if (nowMs < gateMs) {
        const waitSecs = Math.ceil(Number(gateMs - nowMs) / 1000);
        const opensAt  = new Date(Number(gateMs)).toUTCString();
        return {
            ready: false,
            reason: `Round ${roundNumber} not yet open — opens in ~${waitSecs}s (${opensAt})`,
        };
    }

    return { ready: true, roundNumber, groupDatum };
}

// ---------------------------------------------------------------------------
// Reference script loader
// ---------------------------------------------------------------------------

async function loadScriptRefs(
    lucid: LucidEvolution,
    state: ExampleState,
): Promise<DistributePayoutConfig["scriptRefs"] | undefined> {
    if (!state.scriptRefTreasury || !state.scriptRefGroup) return undefined;

    const [tUtxo, gUtxo] = await lucid.utxosByOutRef([
        { txHash: state.scriptRefTreasury.txHash, outputIndex: state.scriptRefTreasury.outputIndex },
        { txHash: state.scriptRefGroup.txHash,    outputIndex: state.scriptRefGroup.outputIndex },
    ]);

    if (tUtxo?.scriptRef && gUtxo?.scriptRef) {
        return { treasury: tUtxo as UTxO, group: gUtxo as UTxO };
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Single poll tick
// ---------------------------------------------------------------------------

async function tick(lucid: LucidEvolution): Promise<{ submitted: boolean; sleepMs: number }> {
    const state = loadState(); // re-read on every tick (state may be updated externally)

    if (!state.groupTokenSuffix) {
        console.log(`[cron] No groupTokenSuffix in state.json — waiting...`);
        return { submitted: false, sleepMs: POLL_INTERVAL_MS };
    }

    const status = await checkRound(lucid, state.groupTokenSuffix);

    if (!status.ready) {
        console.log(`[cron] Not ready: ${status.reason}`);
        return { submitted: false, sleepMs: POLL_INTERVAL_MS };
    }

    const { roundNumber, groupDatum } = status;
    console.log(
        `[cron] Round ${roundNumber + 1n} of ${groupDatum.num_intervals} is open — submitting distribute-payout...`
    );

    const scriptRefs = await loadScriptRefs(lucid, state);
    if (!scriptRefs) {
        console.warn("[cron] No reference scripts found in state.json — using inline scripts (may approach 16KB limit).");
    }

    const config: DistributePayoutConfig = {
        groupTokenSuffix: state.groupTokenSuffix,
        scriptRefs,
    };

    try {
        const txBuilder = await distributePayout(lucid, config).unsafeRun();
        const signed    = await txBuilder.sign.withWallet().complete();
        const txHash    = await signed.submit();
        console.log(`[cron] Submitted: ${txHash}`);

        console.log("[cron] Waiting for on-chain confirmation...");
        await lucid.awaitTx(txHash);
        console.log(`[cron] Confirmed: round ${roundNumber + 1n} of ${groupDatum.num_intervals} distributed.`);

        return { submitted: true, sleepMs: SUBMIT_COOLDOWN_MS };
    } catch (e: unknown) {
        if (String(e).includes("OutsideValidityInterval")) {
            console.warn("[cron] OutsideValidityInterval — network slot lags local clock. Retrying after poll interval.");
            return { submitted: false, sleepMs: POLL_INTERVAL_MS };
        }
        // Log full error, then retry after normal poll interval
        console.error("[cron] Submit failed:");
        logError(e);
        return { submitted: false, sleepMs: POLL_INTERVAL_MS };
    }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let stopping = false;

async function loop(lucid: LucidEvolution): Promise<void> {
    while (!stopping) {
        const now = new Date().toUTCString();
        console.log(`\n[cron] Tick at ${now}`);

        let sleepMs: number;
        try {
            const result = await tick(lucid);
            sleepMs = result.sleepMs;
        } catch (e) {
            // Unexpected top-level failure — log and retry
            console.error("[cron] Unexpected error in tick:");
            logError(e);
            sleepMs = POLL_INTERVAL_MS;
        }

        if (stopping) break;
        console.log(`[cron] Sleeping ${sleepMs / 1000}s until next check...`);
        await sleep(sleepMs);
    }
    console.log("[cron] Stopped.");
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    console.log("=== DCU distribute-payout cron daemon ===");
    console.log(`Poll interval:   ${POLL_INTERVAL_MS / 1000}s`);
    console.log(`Submit cooldown: ${SUBMIT_COOLDOWN_MS / 1000}s`);
    console.log(`Clock buffer:    ${CLOCK_BUFFER_MS / 1000}s (for slot lag)`);

    const lucid = await makeLucid();

    const addr  = await lucid.wallet().address();
    const utxos = await lucid.wallet().getUtxos();
    const total = utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
    console.log(`Daemon wallet:   ${addr}`);
    console.log(`Balance:         ${(Number(total) / 1e6).toFixed(2)} ADA`);

    if (total < 5_000_000n) {
        console.warn("[cron] WARNING: wallet balance below 5 ADA — may not have enough for collateral.");
    }

    process.on("SIGINT",  () => { console.log("\n[cron] SIGINT received — stopping after current poll."); stopping = true; });
    process.on("SIGTERM", () => { console.log("\n[cron] SIGTERM received — stopping after current poll."); stopping = true; });

    await loop(lucid);
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
