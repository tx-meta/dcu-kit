/**
 * Pool Allocate Example
 *
 * The quorum's ratified decision made binding: ONE pool deposit either seeds a
 * brand-new milestone escrow (created in the same transaction) or tops up an
 * existing quorum-funded PerMilestone escrow. The vault enforces that the
 * value lands at the pool's escrow target — pool money can only ever become
 * milestone-disciplined funding. Any deposit remainder continues as the
 * contributor's deposit.
 *
 * REQUIRES the escrow v2 reference script (run escrow-v2-deploy once): the
 * allocation tx witnesses both the vault and the escrow scripts, and inline
 * that exceeds the 16 KB ceiling.
 *
 * Wallet selection: ACTIVE_WALLET must be the quorum (default ADMIN).
 *
 * Env (new-escrow mode):
 *   BENEFICIARY=USER2|addr...        the funded party (required)
 *   VERIFIER=ADMIN|addr...           release authority (default: the quorum)
 *   MILESTONES="10000000:+20m"       amount:deadline (default shown)
 *   GRACE_MINUTES / TITLE            as escrow-v2-create
 * Env (top-up mode):
 *   EXISTING_STATE_TOKEN=...         top up this escrow instead
 * Env (both):
 *   POOL_TOKEN=...                   overrides state.json
 *
 * Usage:
 *   ACTIVE_WALLET=ADMIN BENEFICIARY=USER2 pnpm run pool-allocate
 */

import { allocateToEscrow, AllocateToEscrowConfig } from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, saveState } from "./state.js";
import {
  loadEscrowV2ScriptRef,
  parseMilestones,
  resolvePartyAddress,
  requireToken,
} from "./escrow-v2-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "ADMIN");
  const quorumAddress = await lucid.wallet().address();

  const poolTokenName = requireToken(
    "POOL_TOKEN",
    loadState().poolTokenName,
    "run pool-create first.",
  );
  const escrowScriptRef = await loadEscrowV2ScriptRef(lucid);

  let config: AllocateToEscrowConfig;
  if (process.env.EXISTING_STATE_TOKEN) {
    console.log(
      `Allocating a deposit into existing escrow ${process.env.EXISTING_STATE_TOKEN.slice(0, 16)}…`,
    );
    config = {
      poolTokenName,
      existingStateTokenName: process.env.EXISTING_STATE_TOKEN,
      escrowScriptRef,
    };
  } else {
    const beneficiary = process.env.BENEFICIARY;
    if (!beneficiary)
      throw new Error(
        "BENEFICIARY is required to seed a new escrow (or set EXISTING_STATE_TOKEN).",
      );
    const milestones = parseMilestones(
      process.env.MILESTONES ?? "10000000:+20m",
    );
    console.log(
      `Quorum allocation: seeding a new ${milestones.length}-milestone escrow for ${beneficiary}.`,
    );
    config = {
      poolTokenName,
      newEscrow: {
        beneficiaryAddress: resolvePartyAddress(beneficiary),
        verifier: process.env.VERIFIER
          ? resolvePartyAddress(process.env.VERIFIER)
          : quorumAddress,
        milestones,
        ...(process.env.GRACE_MINUTES
          ? { grace: BigInt(Number(process.env.GRACE_MINUTES) * 60_000) }
          : {}),
        fundingMode: "Upfront",
        timeoutPolicy: "RefundToFunder",
        title: process.env.TITLE ?? "Pool-funded escrow",
      },
      // Full base address so wallets/indexers see the refunds (the default is
      // the quorum's payment credential only).
      escrowFunderAddress: quorumAddress,
      escrowScriptRef,
    };
  }

  const { tx, stateTokenName } = await allocateToEscrow(
    lucid,
    config,
  ).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  saveState({ poolEscrowStateTokenName: stateTokenName });
  console.log("Allocation executed. Escrow state token:", stateTokenName);
  console.log(
    "Manage it with the escrow-v2 scripts via ESCROW_V2_STATE_TOKEN=" +
      stateTokenName,
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
