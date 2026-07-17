/**
 * Open Proposal Example
 *
 * Opens a proposal against a governed vault. The charter's voting mode, quorum,
 * and threshold are read from the anchor (a reference input) and FROZEN into the
 * proposal — they cannot move mid-vote.
 *
 * The opener must hold an eligibility token of the charter's member_policy. That
 * token's UTxO is spent as the one-shot proposal seed, so it also proves opener
 * authority at a resolved index.
 *
 * Env:
 *   MEMBER_UNIT=<policy+name>  the opener's eligibility token unit (required)
 *   TARGET_POLICY=<hex>        the governed vault's state-NFT policy
 *   TARGET_ID=<hex>            the governed vault's state-NFT name
 *   ACTION=ParamChange|SocialPayout|WriteOff|TreasuryMove|MembershipChange
 *   RECIPIENT=<hex>  AMOUNT=<n>        (SocialPayout / TreasuryMove)
 *   FIELD_TAG=<n>    NEW_VALUE=<n>     (ParamChange)
 *   LOAN_ID=<hex>                      (WriteOff)
 *   MEMBER=<hex>     ADMIT=true|false  (MembershipChange)
 *   DEADLINE_MINUTES=60        voting closes this many minutes from now
 *   EXEC_DEADLINE_MINUTES=...  optional execute-by bound
 *
 * Usage:
 *   pnpm run governance-propose
 */

import { buildGovernance, openProposal } from "@tx-meta/dcu-kit/governance";
import type { GovAction } from "@tx-meta/dcu-kit/governance";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, saveState } from "./state.js";
import { govScriptRefs } from "./governance-common.js";

function buildAction(): GovAction {
  const kind = process.env.ACTION ?? "ParamChange";
  switch (kind) {
    case "SocialPayout":
      return {
        SocialPayout: {
          recipient: process.env.RECIPIENT!,
          amount: BigInt(process.env.AMOUNT ?? 0),
        },
      };
    case "TreasuryMove":
      return {
        TreasuryMove: {
          recipient: process.env.RECIPIENT!,
          amount: BigInt(process.env.AMOUNT ?? 0),
        },
      };
    case "WriteOff":
      return { WriteOff: { loan_id: process.env.LOAN_ID! } };
    case "MembershipChange":
      return {
        MembershipChange: {
          member: process.env.MEMBER!,
          admit: (process.env.ADMIT ?? "true") === "true",
        },
      };
    default:
      return {
        ParamChange: {
          field_tag: BigInt(process.env.FIELD_TAG ?? 0),
          new_value: BigInt(process.env.NEW_VALUE ?? 0),
        },
      };
  }
}

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const state = loadState();
  if (!state.governanceSeed) {
    throw new Error("No governanceSeed in state — run governance-init first.");
  }
  const memberUnit = process.env.MEMBER_UNIT ?? state.governanceMemberUnit;
  if (!memberUnit) {
    throw new Error(
      "MEMBER_UNIT is required — the opener's eligibility token (charter member_policy).",
    );
  }
  const targetPolicy = process.env.TARGET_POLICY;
  const targetId = process.env.TARGET_ID;
  if (!targetPolicy || !targetId) {
    throw new Error(
      "TARGET_POLICY and TARGET_ID are required — the governed vault's state-NFT (policy, name).",
    );
  }

  const instance = buildGovernance(state.governanceSeed);
  const scriptRefs = await govScriptRefs(lucid, state);
  const deadline = BigInt(
    Date.now() + Number(process.env.DEADLINE_MINUTES ?? 60) * 60_000,
  );
  const execDeadline = process.env.EXEC_DEADLINE_MINUTES
    ? BigInt(Date.now() + Number(process.env.EXEC_DEADLINE_MINUTES) * 60_000)
    : undefined;

  console.log(
    `Opening a ${process.env.ACTION ?? "ParamChange"} proposal on ${targetId}`,
  );
  const { tx, proposalId } = await openProposal(lucid, {
    instance,
    targetPolicy,
    targetId,
    action: buildAction(),
    deadline,
    ...(execDeadline ? { execDeadline } : {}),
    openerTokenUnit: memberUnit,
    scriptRefs,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  saveState({
    governanceProposalId: proposalId,
    governanceMemberUnit: memberUnit,
  });
  console.log("Proposal open. Id:", proposalId);
  console.log("Members vote with governance-vote.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
