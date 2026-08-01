/**
 * Deploy Escrow V2 Reference Script
 *
 * Publishes the escrow v2 spending script (11.4 KB) as a reference-script UTxO.
 * Pool allocations must witness both the vault and the escrow scripts in one
 * transaction — inline that breaks the 16 KB tx ceiling, so the escrow script
 * has to ride as a reference input.
 *
 * The UTxO goes to the permanent alwaysFails address, not to the deployer's
 * wallet. A wallet-held reference script is an ordinary spendable input: Lucid
 * only excludes reference UTxOs from coin selection when they were passed via
 * `readFrom`, so one sitting in the wallet can fund an unrelated transaction
 * and the deployed script is gone. The deposit (~50 ADA, scaled to the script
 * size) is the price of a reference that can never be spent by anyone.
 *
 * Re-running is safe — a recorded reference that is still on-chain with the
 * same hash is reused rather than republished.
 *
 * Usage:
 *   pnpm run escrow-v2-deploy
 */

import { Effect } from "effect";
import { deployModuleScripts } from "@tx-meta/dcu-kit";
import {
  escrowV2Validator,
  escrowV2PolicyId,
} from "@tx-meta/dcu-kit/escrow/v2";
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

  console.log(`Escrow v2 policy: ${escrowV2PolicyId}`);
  const result = await Effect.runPromise(
    deployModuleScripts({ escrowV2: escrowV2Validator.spendEscrow }, lucid, {
      existing: { escrowV2: recordedModuleRef("scriptRefEscrowV2") },
    }),
  );

  const ref = result.refs.escrowV2!;
  saveState({ scriptRefEscrowV2: ref });

  if (result.status.escrowV2 === "reused") {
    console.log(
      `Escrow v2 reference script already live at ${ref.txHash}#${ref.outputIndex} — nothing to do.`,
    );
    return;
  }
  console.log(`Deployed at ${ref.txHash}#${ref.outputIndex}`);
  console.log(
    `Address: ${result.deployAddress} (alwaysFails — never spendable)`,
  );
  console.log(
    "pool-allocate (and any v2 tx that wants a smaller footprint) will use it.",
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
