/**
 * Init Governance Example
 *
 * Instantiates a governance instance (primitive #9): consumes a seed UTxO, mints
 * the one-shot anchor NFT under the seeded settings policy, and locks the charter
 * — which publishes this instance's voting and gate hashes.
 *
 * The seed makes every downstream hash unique, so a target vault's `quorum`
 * Credential commits to exactly THIS instance's gate. We persist only the seed:
 * `buildGovernance(seed)` re-derives the whole instance on every later run.
 *
 * It also registers the voting stake credential — every proposal transaction
 * carries a 0-ADA withdrawal from it (withdraw-zero), and the ledger rejects a
 * withdrawal from an unregistered credential.
 *
 * Wallet: ACTIVE_WALLET (default USER1) pays the anchor min-ADA and the 2 ADA
 * stake deposit; its payment credential is the charter creator.
 *
 * Env:
 *   TITLE="..."             max 64 UTF-8 bytes
 *   MEMBER_POLICY=<policy>  eligibility token policy (e.g. the savings user-token
 *                           policy). Holding a token of it makes a voter.
 *   GOVERNED_TARGETS=a,b    target ids (hex) this instance may govern — the state
 *                           token NAME of each governed vault
 *   QUORUM=2                min total weight cast for a proposal to be decidable
 *   THRESHOLD=5000          min yes-share in basis points (5000 = 50%)
 *   TIMELOCK_MS=0           delay between Passed and the earliest Executed
 *
 * Usage:
 *   pnpm run governance-init
 */

import {
  initGovernance,
  registerVotingStake,
} from "@tx-meta/dcu-kit/governance";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { saveState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const memberPolicy = process.env.MEMBER_POLICY;
  if (!memberPolicy) {
    throw new Error(
      "MEMBER_POLICY is required — the eligibility token policy whose holders may vote.",
    );
  }
  const governedTargets = (process.env.GOVERNED_TARGETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (governedTargets.length === 0) {
    throw new Error(
      "GOVERNED_TARGETS is required — comma-separated state-token names of the vaults this instance governs.",
    );
  }

  const title = process.env.TITLE ?? "Preprod sweep governance";
  console.log(`Creating governance instance "${title}"`);

  const { tx, instance } = await initGovernance(lucid, {
    title,
    memberPolicy,
    governedTargets,
    quorum: BigInt(process.env.QUORUM ?? 2),
    threshold: BigInt(process.env.THRESHOLD ?? 5000),
    timelock: BigInt(process.env.TIMELOCK_MS ?? 0),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Anchor mint submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  saveState({ governanceSeed: instance.seed });
  console.log("Governance instance created.");
  console.log("  settings policy :", instance.settingsPolicy);
  console.log("  dispatcher      :", instance.govPolicy);
  console.log("  voting stake    :", instance.votingStakeHash);
  console.log("  gate (quorum)   :", instance.gateHash);
  console.log(
    "\nPoint a vault's quorum Credential at the GATE hash above to let this instance govern it.",
  );

  // Register the voting stake credential (one-time; the withdraw-zero trigger).
  console.log("\nRegistering the voting stake credential...");
  const regTx = await registerVotingStake(lucid, instance).unsafeRun();
  const regSigned = await regTx.sign.withWallet().complete();
  const regHash = await regSigned.submit();
  console.log("Stake registration submitted. Hash:", regHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(regHash));
  await lucid.awaitTx(regHash);

  console.log(
    "\nVoting stake registered. Open a proposal with governance-propose.",
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
