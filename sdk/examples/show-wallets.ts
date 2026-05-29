/**
 * Show Wallets — diagnostic utility for manual Preprod testing.
 *
 * Prints address, ADA balance, and any DCU NFTs held in each wallet
 * (ADMIN, USER1, USER2). Use this before a test run to understand
 * current on-chain state and spot stale tokens from old validators.
 *
 * Usage:
 *   pnpm run show-wallets
 */

import "dotenv/config";
import { Lucid, Blockfrost, Maestro } from "@lucid-evolution/lucid";
import {
  groupPolicyId,
  accountPolicyId,
  assetNameLabels,
} from "@tx-meta/dcu-sdk";
import { cexplorerTxUrl, logError } from "./context.js";

const LIVE_NETWORKS = ["Preprod", "Mainnet", "Preview"] as const;
type LiveNetwork = (typeof LIVE_NETWORKS)[number];
function liveNetwork(raw: string | undefined): LiveNetwork | null {
  return (LIVE_NETWORKS as readonly string[]).includes(raw ?? "")
    ? (raw as LiveNetwork)
    : null;
}

function lovelaceToAda(lovelace: bigint): string {
  return (Number(lovelace) / 1_000_000).toFixed(2);
}

function labelToken(
  policyId: string,
  unit: string,
  knownGroupPolicy: string | undefined,
  knownAccountPolicy: string | undefined,
): string {
  const assetPart = unit.slice(policyId.length); // prefix + suffix
  const prefix4 = assetPart.slice(0, 4);
  const suffix = assetPart.slice(4);
  let kind = "";

  if (policyId === knownGroupPolicy) {
    kind =
      prefix4 === assetNameLabels.prefix100
        ? "GroupRef(100)"
        : prefix4 === assetNameLabels.prefix222
          ? "GroupCreator(222)"
          : `GroupToken(${prefix4})`;
  } else if (policyId === knownAccountPolicy) {
    kind =
      prefix4 === assetNameLabels.prefix100
        ? "AccountRef(100)"
        : prefix4 === assetNameLabels.prefix222
          ? "AccountUser(222)"
          : `AccountToken(${prefix4})`;
  } else {
    kind = "UnknownToken";
  }
  return `${kind}  suffix: ${suffix}  policy: ${policyId}`;
}

async function showWallet(
  lucid: Awaited<ReturnType<typeof Lucid>>,
  name: string,
  seed: string,
  network: LiveNetwork,
) {
  lucid.selectWallet.fromSeed(seed);
  const address = await lucid.wallet().address();
  const utxos = await lucid.wallet().getUtxos();

  let totalLovelace = 0n;
  const dcuTokens: string[] = [];
  const unknownTokens: string[] = [];

  for (const utxo of utxos) {
    for (const [unit, qty] of Object.entries(utxo.assets)) {
      if (unit === "lovelace") {
        totalLovelace += qty;
        continue;
      }
      const policyId = unit.slice(0, 56);
      if (policyId === groupPolicyId || policyId === accountPolicyId) {
        dcuTokens.push(
          labelToken(
            policyId,
            unit,
            groupPolicyId ?? undefined,
            accountPolicyId ?? undefined,
          ),
        );
      } else {
        unknownTokens.push(`${unit} ×${qty}`);
      }
    }
  }

  const subdomain = network === "Mainnet" ? "" : `${network.toLowerCase()}.`;
  const explorerUrl = `https://${subdomain}cexplorer.io/address/${address}`;

  console.log(`\n┌─ ${name}`);
  console.log(`│  Address : ${address}`);
  console.log(`│  Explorer: ${explorerUrl}`);
  console.log(
    `│  ADA     : ${lovelaceToAda(totalLovelace)} ADA  (${utxos.length} UTxO${utxos.length !== 1 ? "s" : ""})`,
  );

  if (dcuTokens.length > 0) {
    console.log(`│  DCU tokens:`);
    for (const t of dcuTokens) console.log(`│    • ${t}`);
  } else {
    console.log(`│  DCU tokens: none`);
  }

  if (unknownTokens.length > 0) {
    console.log(`│  Other tokens:`);
    for (const t of unknownTokens) console.log(`│    • ${t}`);
  }
  console.log(`└${"─".repeat(80)}`);
}

async function main() {
  const network = liveNetwork(process.env.NETWORK);
  if (!network) {
    console.log(
      "show-wallets requires a live network (NETWORK=Preprod in .env).",
    );
    process.exit(0);
  }

  const blockfrostKey = process.env.BLOCKFROST_KEY;
  const maestroKey = process.env.MAESTRO_API_KEY;

  let lucid: Awaited<ReturnType<typeof Lucid>>;
  if (blockfrostKey) {
    const url =
      process.env.BLOCKFROST_URL ??
      "https://cardano-preprod.blockfrost.io/api/v0";
    lucid = await Lucid(new Blockfrost(url, blockfrostKey), network);
  } else if (maestroKey) {
    lucid = await Lucid(
      new Maestro({ network, apiKey: maestroKey, turboSubmit: false }),
      network,
    );
  } else {
    console.error(
      "No provider configured. Set BLOCKFROST_KEY or MAESTRO_API_KEY in .env",
    );
    process.exit(1);
  }

  console.log(`\nWallet state on ${network}`);
  console.log(`Group  policy: ${groupPolicyId ?? "(none)"}`);
  console.log(`Account policy: ${accountPolicyId ?? "(none)"}`);

  const wallets = [
    ["ADMIN", process.env.ADMIN_SEED],
    ["USER1", process.env.USER1_SEED],
    ["USER2", process.env.USER2_SEED],
  ] as const;

  for (const [name, seed] of wallets) {
    if (!seed) {
      console.log(`\n${name}: no seed in .env — skipping`);
      continue;
    }
    await showWallet(lucid, name, seed, network);
  }
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
