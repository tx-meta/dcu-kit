/**
 * Preprod teardown, phase 1: retire every expirable proposal on the current
 * governance instance.
 *
 * Expiry is permissionless and reclaims the proposal NFT's min-ADA. The
 * on-chain rule (validate_expire) allows it for an Open proposal past its
 * deadline, a Passed one past its exec_deadline, and Executed or Rejected at
 * any time. A Passed proposal with no exec_deadline is never expirable, so it
 * is reported and skipped rather than attempted.
 *
 * Usage: from sdk/, `npx tsx examples/teardown-governance.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { buildGovernance } from "../src/governance/validators.js";
import { getProposalsProgram } from "../src/governance/queries/getProposals.js";
import { unsignedExpireProposalTxProgram } from "../src/governance/endpoints/expireProposal.js";
import manifest from "../src/core/deployments/preprod.json" with { type: "json" };

const env = {};
for (const line of readFileSync("./examples/.env", "utf8").split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#") && t.includes("=")) {
    const [k, ...v] = t.split("=");
    env[k.trim()] = v.join("=").trim().replace(/^["']|["']$/g, "");
  }
}
const lucid = await Lucid(
  new Blockfrost(env.BLOCKFROST_URL, env.BLOCKFROST_KEY),
  "Preprod",
);
lucid.selectWallet.fromSeed(env.USER1_SEED);

const settle = (s = 45) => new Promise((r) => setTimeout(r, s * 1000));
const ref = async (key) => {
  const e = manifest.refScripts[key];
  const [u] = await lucid.utxosByOutRef([
    { txHash: e.txHash, outputIndex: e.outputIndex },
  ]);
  return u;
};
const scriptRefs = {
  dispatcher: await ref("governanceDispatcher"),
  voting: await ref("governanceVoting"),
};
const instance = buildGovernance(manifest.governance.seed);

const proposals = await Effect.runPromise(
  getProposalsProgram(lucid, instance),
);
console.log(`live proposals: ${proposals.length}\n`);

const now = () => BigInt(Date.now()) - 60_000n;
const expirable = (p) => {
  const s = p.proposal.status;
  if (s === "Executed" || s === "Rejected") return true;
  if (s === "Open") return now() > p.proposal.deadline;
  if (s === "Passed")
    return p.proposal.exec_deadline !== null && now() > p.proposal.exec_deadline;
  return false;
};

const done = [];
const skipped = [];
for (const p of proposals) {
  const id = p.proposalId;
  if (!expirable(p)) {
    skipped.push(`${id.slice(0, 12)}… status=${p.proposal.status} exec_deadline=${p.proposal.exec_deadline}`);
    continue;
  }
  const built = await Effect.runPromise(
    Effect.either(
      unsignedExpireProposalTxProgram(lucid, {
        instance,
        proposalId: id,
        currentTime: now(),
        scriptRefs,
      }),
    ),
  );
  if (built._tag !== "Right") {
    skipped.push(`${id.slice(0, 12)}… BUILD FAILED ${String(built.left).slice(0, 160)}`);
    continue;
  }
  try {
    const signed = await built.right.sign.withWallet().complete();
    const hash = await signed.submit();
    console.log(`expire ${id.slice(0, 12)}… (${p.proposal.status}): ${hash}`);
    await lucid.awaitTx(hash);
    await settle();
    done.push(id);
  } catch (e) {
    skipped.push(`${id.slice(0, 12)}… SUBMIT FAILED ${String(e).slice(0, 160)}`);
  }
}

console.log(`\nexpired: ${done.length}`);
console.log(`skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  ${s}`);
