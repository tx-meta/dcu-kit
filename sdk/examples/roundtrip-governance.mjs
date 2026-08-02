/**
 * Live Preprod governance round trip on the post-wave hashes:
 * join the governed fund → register as a voter → open → vote → finalize →
 * execute. Finalize and execute have never run live; the vote now also proves
 * the voter-to-fund binding, because this instance's electorate IS the savings
 * policy that identifies the fund.
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { buildGovernance } from "../src/governance/validators.js";
import { unsignedJoinFundTxProgram } from "../src/savings/endpoints/joinFund.js";
import { unsignedRegisterVoterTxProgram } from "../src/governance/endpoints/registerVoter.js";
import { unsignedOpenProposalTxProgram } from "../src/governance/endpoints/openProposal.js";
import { unsignedCastVoteTxProgram } from "../src/governance/endpoints/castVote.js";
import { unsignedFinalizeProposalTxProgram } from "../src/governance/endpoints/finalizeProposal.js";
import { unsignedExecuteDecisionTxProgram } from "../src/governance/endpoints/executeDecision.js";
import {
  govActionForOperation,
  SavingsOperation,
} from "../src/governance/utils.js";
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
const settle = (s = 75) => new Promise((r) => setTimeout(r, s * 1000));
const submit = async (tx, label) => {
  const signed = await tx.sign.withWallet().complete();
  const hash = await signed.submit();
  console.log(`${label}: ${hash}`);
  await lucid.awaitTx(hash);
  await settle();
  return hash;
};

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
const instance = buildGovernance(manifest.governance.seed);
const fundTokenName = manifest.governance.governedFund;
const savingsPolicy = manifest.governance.memberPolicy;

// 1. Join the fund. This mints the member (100)/(222) pair. The (222) is the
//    eligibility token; the (100) account is what binds the voter to this fund.
const { tx: joinTx, memberTokenSuffix } = await Effect.runPromise(
  unsignedJoinFundTxProgram(lucid, {
    scriptRef: savingsRef,
    fundTokenName,
    consent: true,
  }),
);
await submit(joinTx, "joinFund");
const voterTokenUnit =
  savingsPolicy + assetNameLabels.prefix222 + memberTokenSuffix;
console.log("  voterTokenUnit:", voterTokenUnit);

// 2. Register as a voter. The validator reference-reads the member account and
//    requires its fund_id to be this instance's governed fund.
const { tx: regTx } = await Effect.runPromise(
  unsignedRegisterVoterTxProgram(lucid, {
    instance,
    voterTokenUnit,
    scriptRefs,
  }),
);
await submit(regTx, "registerVoter");

// 3. Open a proposal that authorizes exactly one operation on the fund.
const now = BigInt(Date.now()) - 60_000n;
const deadline = now + 900_000n;
const { tx: openTx, proposalId } = await Effect.runPromise(
  unsignedOpenProposalTxProgram(lucid, {
    instance,
    targetPolicy: savingsPolicy,
    targetId: fundTokenName,
    action: govActionForOperation(SavingsOperation.UpdateFund),
    deadline,
    openerTokenUnit: voterTokenUnit,
    currentTime: now,
    scriptRefs,
  }),
);
await submit(openTx, "openProposal");
console.log("  proposalId:", proposalId);

// 4. Cast the single vote quorum needs.
const { tx: voteTx } = await Effect.runPromise(
  unsignedCastVoteTxProgram(lucid, {
    instance,
    proposalId,
    approve: true,
    voterTokenUnit,
    currentTime: BigInt(Date.now()) - 60_000n,
    scriptRefs,
  }),
);
await submit(voteTx, "castVote");

// 5. Finalize. Only valid strictly after the deadline. Never run live before.
const waitMs = Number(deadline - BigInt(Date.now())) + 90_000;
if (waitMs > 0) {
  console.log(
    `waiting ${Math.ceil(waitMs / 1000)}s for the voting deadline...`,
  );
  await new Promise((r) => setTimeout(r, waitMs));
}
const { tx: finTx, passed } = await Effect.runPromise(
  unsignedFinalizeProposalTxProgram(lucid, {
    instance,
    proposalId,
    currentTime: BigInt(Date.now()) - 60_000n,
    scriptRefs,
  }),
);
console.log("  passed:", passed);
await submit(finTx, "finalizeProposal");

// 6. Execute. Mints the one-shot decision at the gate. Never run live before.
const { tx: execTx, decisionName } = await Effect.runPromise(
  unsignedExecuteDecisionTxProgram(lucid, {
    instance,
    proposalId,
    currentTime: BigInt(Date.now()) - 60_000n,
    scriptRefs,
  }),
);
await submit(execTx, "executeDecision");
console.log("  decisionName:", decisionName);
console.log("\nROUND TRIP COMPLETE");
