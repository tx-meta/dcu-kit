/**
 * Create Escrow V2 Example
 *
 * Opens a v2 milestone escrow: per-milestone deadlines + a grace window,
 * Upfront or PerMilestone funding, a timeout policy (funder refund vs
 * auto-release), an optional arbiter (dispute path), optional payout-only
 * co-beneficiaries (basis-point splits), and an optional Project anchor link.
 *
 * Every party is a plain address or a .env wallet name — nobody types a
 * credential hash (the Kyama UX rule).
 *
 * Wallet selection: ACTIVE_WALLET (default USER1) is the funder.
 *
 * Env:
 *   BENEFICIARY=USER2|addr_test1...    primary payout destination (required)
 *   VERIFIER=ADMIN|addr_test1...       release authority (default: the funder — demo only)
 *   ARBITER=ADMIN|addr...              optional — enables the dispute path
 *   MILESTONES="3000000:+8m,2000000:+30m"  amount:deadline (default shown)
 *   FUNDING_MODE=Upfront|PerMilestone  default Upfront
 *   TIMEOUT_POLICY=RefundToFunder|ReleaseToBeneficiary  default RefundToFunder
 *   GRACE_MINUTES=5                    cure window (default: SDK 14 days)
 *   DISPUTE_MINUTES=3                  freeze length (default: SDK 7 days)
 *   CO_BENEFICIARIES="ADMIN:1000"      payout splits, name|addr:bps
 *   TITLE="..."                        max 64 UTF-8 bytes
 *   USE_PROJECT=1                      cite state.json's projectTokenName
 *
 * Usage:
 *   BENEFICIARY=USER2 VERIFIER=ADMIN pnpm run escrow-v2-create
 */

import { CreateEscrowV2Config, createEscrow } from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, saveState } from "./state.js";
import {
  parseMilestones,
  resolvePartyAddress,
  untilLabel,
} from "./escrow-v2-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const beneficiaryRef = process.env.BENEFICIARY;
  if (!beneficiaryRef)
    throw new Error(
      "BENEFICIARY is required (a wallet name or address). Example:\n" +
        "  BENEFICIARY=USER2 VERIFIER=ADMIN pnpm run escrow-v2-create",
    );

  const milestones = parseMilestones(
    process.env.MILESTONES ?? "3000000:+8m,2000000:+30m",
  );
  const fundingMode = (process.env.FUNDING_MODE ?? "Upfront") as
    "Upfront" | "PerMilestone";
  const timeoutPolicy = (process.env.TIMEOUT_POLICY ?? "RefundToFunder") as
    "RefundToFunder" | "ReleaseToBeneficiary";

  let verifier = process.env.VERIFIER;
  if (!verifier) {
    verifier = await lucid.wallet().address();
    console.warn(
      "VERIFIER not set — using the funder's own address as verifier (demo only).",
    );
  }

  const coBeneficiaries = (process.env.CO_BENEFICIARIES ?? "")
    .split(",")
    .filter((s) => s.trim())
    .map((s) => {
      const [ref, bps] = s.trim().split(":");
      return { address: resolvePartyAddress(ref), shareBps: BigInt(bps) };
    });

  const projectId =
    process.env.USE_PROJECT === "1" ? loadState().projectTokenName : undefined;
  if (process.env.USE_PROJECT === "1" && !projectId)
    throw new Error("USE_PROJECT=1 but no projectTokenName in state.json.");

  const total = milestones.reduce((a, m) => a + m.amount, 0n);
  console.log(
    `Escrow v2: ${milestones.length} milestone(s), ${Number(total) / 1e6} ADA total, ` +
      `${fundingMode} / ${timeoutPolicy}` +
      (coBeneficiaries.length
        ? `, ${coBeneficiaries.length} co-beneficiary`
        : "") +
      (projectId ? `, project ${projectId.slice(0, 12)}…` : ""),
  );
  for (const [i, m] of milestones.entries())
    console.log(
      `  m${i}: ${Number(m.amount) / 1e6} ADA, deadline ${untilLabel(m.deadline)}`,
    );

  const config: CreateEscrowV2Config = {
    beneficiaryAddress: resolvePartyAddress(beneficiaryRef),
    ...(coBeneficiaries.length ? { coBeneficiaries } : {}),
    verifier: resolvePartyAddress(verifier),
    ...(process.env.ARBITER
      ? { arbiter: resolvePartyAddress(process.env.ARBITER) }
      : {}),
    milestones,
    ...(process.env.GRACE_MINUTES
      ? { grace: BigInt(Number(process.env.GRACE_MINUTES) * 60_000) }
      : {}),
    ...(process.env.DISPUTE_MINUTES
      ? {
          disputeWindow: BigInt(Number(process.env.DISPUTE_MINUTES) * 60_000),
        }
      : {}),
    fundingMode,
    timeoutPolicy,
    title: process.env.TITLE ?? "Preprod sweep escrow",
    ...(projectId ? { projectId } : {}),
  };

  console.log("Building create-escrow transaction...");
  const { tx, stateTokenName } = await createEscrow(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  saveState({ escrowV2StateTokenName: stateTokenName });
  console.log("Escrow v2 created. State token:", stateTokenName);
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
