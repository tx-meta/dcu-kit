/**
 * Top Up Reserve Example
 *
 * Donates to the group's mutual reserve (harambee). Permissionless — any
 * wallet may top up any group's reserve; the validator only lets the pot grow
 * through this door.
 *
 * Wallet selection:
 *   Default (USER1): uses USER1_SEED from .env
 *   ACTIVE_WALLET=ADMIN / USER2: donate from another wallet
 *
 * Amount:
 *   RESERVE_TOPUP=1000000  — donation in the group's CONTRIBUTION asset
 *                            (lovelace for ADA groups). Default 1 ADA.
 *
 * Usage:
 *   pnpm run top-up-reserve
 *   RESERVE_TOPUP=5000000 pnpm run top-up-reserve
 */

import { Effect } from "effect";
import { TopUpReserveConfig, getReserveStateProgram } from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
  loadScriptRefs,
} from "./context.js";
import { loadState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const sdk = loadSdk();
  const state = loadState();
  const groupTokenSuffix =
    process.env.GROUP_TOKEN_SUFFIX ?? state.groupTokenSuffix;
  if (!groupTokenSuffix)
    throw new Error(
      "No groupTokenSuffix in state.json (and GROUP_TOKEN_SUFFIX not set). Run create-group first.",
    );

  const amount = BigInt(process.env.RESERVE_TOPUP ?? "1000000");

  const before = await Effect.runPromise(
    getReserveStateProgram(sdk.protocol, lucid, groupTokenSuffix),
  );
  console.log(
    `Reserve before: balance ${before.balance}  stand-in rounds ${before.standinRounds}`,
  );

  const { treasury } = await loadScriptRefs(lucid);
  const config: TopUpReserveConfig = {
    groupTokenSuffix,
    amount,
    scriptRefs: { treasury },
  };

  console.log(`Building top-up transaction (${amount} units)...`);
  const tx = await sdk.topUpReserve(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  const after = await Effect.runPromise(
    getReserveStateProgram(sdk.protocol, lucid, groupTokenSuffix),
  );
  console.log(
    `Reserve after:  balance ${after.balance}  stand-in rounds ${after.standinRounds}`,
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
