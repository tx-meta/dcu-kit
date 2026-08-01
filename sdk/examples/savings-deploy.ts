/**
 * Savings Deploy Example
 *
 * Deploys the savings-credit validator as a reference script (once). The
 * ~15.6KB script cannot ride inline within the 16KB tx limit, so every
 * other savings script resolves this reference from state.json.
 *
 * The reference script goes to the permanent alwaysFails address, not to the
 * deployer's wallet: a wallet-held reference UTxO is an ordinary spendable
 * input that coin selection can consume, which takes savings down for everyone.
 * The deposit (~70 ADA, scaled to the script size) is the price of that.
 *
 * Re-running is safe — a recorded reference that is still on-chain with the
 * same hash is reused rather than republished.
 *
 * Wallet selection: ACTIVE_WALLET pays the ref deposit (default USER1).
 *
 * Usage:
 *   pnpm run savings-deploy
 */

import { Effect } from "effect";
import { deployModuleScripts } from "@tx-meta/dcu-kit";
import { savingsVaultValidator } from "@tx-meta/dcu-kit/savings";
import { logError, makeLucid, selectEnvWallet } from "./context.js";
import { recordedModuleRef, saveState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const result = await Effect.runPromise(
    deployModuleScripts({ savings: savingsVaultValidator.spendVault }, lucid, {
      existing: { savings: recordedModuleRef("scriptRefSavings") },
    }),
  );

  const ref = result.refs.savings!;
  saveState({ scriptRefSavings: ref });

  if (result.status.savings === "reused") {
    console.log(
      `Savings reference script already live at ${ref.txHash}#${ref.outputIndex} — nothing to do.`,
    );
    return;
  }
  console.log(`Deployed at ${ref.txHash}#${ref.outputIndex}`);
  console.log(
    `Address: ${result.deployAddress} (alwaysFails — never spendable)`,
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
