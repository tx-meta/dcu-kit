/**
 * Live Preprod: governance actually GOVERNING a savings fund, end to end, on
 * the post-charter-freeze hashes.
 *
 * The previous instance is bound to the OLD savings policy as its electorate
 * (member_policy is baked in at init and cannot be amended), so a savings hash
 * change strands it. This stands up a fresh one and drives the whole loop:
 *
 *   init governance → create a fund whose quorum IS the gate → bind the fund
 *   as a governed target → join → register → propose → vote → finalize →
 *   execute → SPEND the decision to mutate the fund.
 *
 * The last step is the one that matters. Minting a decision token proves the
 * vote; spending it at the gate to move a fund the wallet has no authority
 * over is what proves the composition.
 *
 * Ordering note: the fund's quorum must be Script(gateHash), which only exists
 * after init; and the charter's governed target needs the fund id, which only
 * exists after createFund. So init → createFund → updateCharter.
 *
 * Usage: from sdk/, `npx tsx examples/roundtrip-governed-savings.mjs`
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { unsignedInitGovernanceTxProgram } from "../src/governance/endpoints/initGovernance.js";
import { unsignedUpdateCharterTxProgram } from "../src/governance/endpoints/updateCharter.js";
import { unsignedRegisterVoterTxProgram } from "../src/governance/endpoints/registerVoter.js";
import { unsignedOpenProposalTxProgram } from "../src/governance/endpoints/openProposal.js";
import { unsignedCastVoteTxProgram } from "../src/governance/endpoints/castVote.js";
import { unsignedFinalizeProposalTxProgram } from "../src/governance/endpoints/finalizeProposal.js";
import { unsignedExecuteDecisionTxProgram } from "../src/governance/endpoints/executeDecision.js";
import { gateWitnessProgram } from "../src/governance/endpoints/authorizeAction.js";
import {
  govActionForOperation,
  SavingsOperation,
} from "../src/governance/utils.js";
import { unsignedCreateFundTxProgram } from "../src/savings/endpoints/createFund.js";
import { unsignedJoinFundTxProgram } from "../src/savings/endpoints/joinFund.js";
import { unsignedUpdateFundTxProgram } from "../src/savings/endpoints/updateFund.js";
import { getFundStateProgram } from "../src/savings/queries/getFundState.js";
import { resolveFund } from "../src/savings/utils.js";
import { savingsPolicyId } from "../src/savings/validators.js";
import { GroupType } from "../src/savings/types.js";
import { assetNameLabels } from "../src/core/utils/index.js";
import manifest from "../src/core/deployments/preprod.json" with { type: "json" };

const env = {};
for (const line of readFileSync("./examples/.env", "utf8").split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#") && t.includes("=")) {
    const [k, ...v] = t.split("=");
    env[k.trim()] = v
      .join("=")
      .trim()
      .replace(/^["']|["']$/g, "");
  }
}
const lucid = await Lucid(
  new Blockfrost(env.BLOCKFROST_URL, env.BLOCKFROST_KEY),
  "Preprod",
);
lucid.selectWallet.fromSeed(env.USER1_SEED);

const settle = () => new Promise((r) => setTimeout(r, 75_000));
const submit = async (tx, label) => {
  const signed = await tx.sign.withWallet().complete();
  const hash = await signed.submit();
  console.log(`${label}: ${hash}`);
  await lucid.awaitTx(hash);
  await settle();
  return hash;
};
const now = () => BigInt(Date.now()) - 60_000n;

const ref = async (key) => {
  const e = manifest.refScripts[key];
  const [u] = await lucid.utxosByOutRef([
    { txHash: e.txHash, outputIndex: e.outputIndex },
  ]);
  return u;
};
const savingsRef = await ref("savings");
const scriptRefs = {
  dispatcher: await ref("governanceDispatcher"),
  voting: await ref("governanceVoting"),
};
console.log("savings policy (electorate):", savingsPolicyId);

// 1. Stand up the instance. The electorate IS the savings policy, so voter
//    eligibility and fund identity share one policy — the exact collision the
//    voter-to-fund binding closes.
const { tx: initTx, instance } = await Effect.runPromise(
  unsignedInitGovernanceTxProgram(lucid, {
    title: "Preprod savings governance",
    memberPolicy: savingsPolicyId,
    governedTargets: [],
    quorum: 1n,
    threshold: 5000n,
    // Tag 5 is Generic — without it, operation-bound proposals are refused.
    openerPolicy: [[5n, "AnyMember"]],
  }),
);
await submit(initTx, "initGovernance");
console.log("  gateHash:", instance.gateHash);
console.log("  govPolicy:", instance.govPolicy);

// 2. The fund's quorum is the gate: no key can amend this charter.
const { tx: fundTx, fundTokenName } = await Effect.runPromise(
  unsignedCreateFundTxProgram(lucid, {
    scriptRef: savingsRef,
    title: "Governed savings fund",
    groupType: GroupType.Vsla,
    shareValue: 1_000_000n,
    minSharesPerDeposit: 1n,
    maxSharesPerDeposit: 100n,
    withdrawalPolicy: 0n,
    maxLoanMultiple: 1n,
    quorum: { type: "Script", hash: instance.gateHash },
  }),
);
await submit(fundTx, "createFund (quorum = the gate)");
console.log("  fundTokenName:", fundTokenName);

// 3. Bind the fund as the charter's governed target.
const charterTx = await Effect.runPromise(
  unsignedUpdateCharterTxProgram(lucid, {
    instance,
    governedTargets: [[savingsPolicyId, fundTokenName]],
  }),
);
await submit(charterTx, "updateCharter (bind the fund)");

// 4. Join — the (222) token is eligibility, the (100) account binds the voter
//    to THIS fund.
const { tx: joinTx, memberTokenSuffix } = await Effect.runPromise(
  unsignedJoinFundTxProgram(lucid, {
    scriptRef: savingsRef,
    fundTokenName,
    consent: true,
  }),
);
await submit(joinTx, "joinFund");
const voterTokenUnit =
  savingsPolicyId + assetNameLabels.prefix222 + memberTokenSuffix;

const regTx = await Effect.runPromise(
  unsignedRegisterVoterTxProgram(lucid, {
    instance,
    voterTokenUnit,
    scriptRefs,
  }),
);
await submit(regTx, "registerVoter");

// 5. Propose exactly one operation on exactly this fund.
const deadline = now() + 900_000n;
const { tx: openTx, proposalId } = await Effect.runPromise(
  unsignedOpenProposalTxProgram(lucid, {
    instance,
    targetPolicy: savingsPolicyId,
    targetId: fundTokenName,
    action: govActionForOperation(SavingsOperation.UpdateFund),
    deadline,
    openerTokenUnit: voterTokenUnit,
    currentTime: now(),
    scriptRefs,
  }),
);
await submit(openTx, "openProposal (UpdateFund)");

const voteTx = await Effect.runPromise(
  unsignedCastVoteTxProgram(lucid, {
    instance,
    proposalId,
    approve: true,
    voterTokenUnit,
    currentTime: now(),
    scriptRefs,
  }),
);
await submit(voteTx, "castVote");

const waitMs = Number(deadline - BigInt(Date.now())) + 90_000;
if (waitMs > 0) {
  console.log(`waiting ${Math.ceil(waitMs / 1000)}s for the deadline...`);
  await new Promise((r) => setTimeout(r, waitMs));
}
const { tx: finTx, passed } = await Effect.runPromise(
  unsignedFinalizeProposalTxProgram(lucid, {
    instance,
    proposalId,
    currentTime: now(),
    scriptRefs,
  }),
);
console.log("  passed:", passed);
await submit(finTx, "finalizeProposal");

const { tx: execTx, decisionName } = await Effect.runPromise(
  unsignedExecuteDecisionTxProgram(lucid, {
    instance,
    proposalId,
    currentTime: now(),
    scriptRefs,
  }),
);
await submit(execTx, "executeDecision");
console.log("  decisionName:", decisionName);

// 6. THE POINT: spend the decision at the gate to amend a fund this wallet
//    has no authority over. The new title is the observable proof.
const before = await Effect.runPromise(
  getFundStateProgram(lucid, fundTokenName),
);
console.log("  title before:", before.fund.title);

// The gate fragment INDEXES the fund input without collecting it — updateFund
// spends it with its own UpdateFund redeemer, in the same transaction.
const { utxo: fundUtxo } = await Effect.runPromise(
  resolveFund(lucid, fundTokenName),
);
const gateWitness = await Effect.runPromise(
  gateWitnessProgram(lucid, {
    instance,
    proposalId,
    targetUtxo: fundUtxo,
    scriptRefs,
  }),
);
const amend = await Effect.runPromise(
  unsignedUpdateFundTxProgram(lucid, {
    scriptRef: savingsRef,
    fundTokenName,
    title: "Amended by governance",
    quorumWitness: { extend: gateWitness },
  }),
);
await submit(amend, "updateFund via the gate (decision spent)");

const after = await Effect.runPromise(
  getFundStateProgram(lucid, fundTokenName),
);
console.log("  title after:", after.fund.title);
if (after.fund.title === before.fund.title) {
  throw new Error("the decision did not mutate the fund");
}

writeFileSync(
  "./examples/governed-savings.json",
  JSON.stringify(
    {
      seed: instance.seed,
      gateHash: instance.gateHash,
      govPolicy: instance.govPolicy,
      memberPolicy: savingsPolicyId,
      governedFund: fundTokenName,
    },
    null,
    2,
  ),
);
console.log(
  "\nGOVERNED SAVINGS ROUND TRIP COMPLETE — the gate moved the fund.",
);
