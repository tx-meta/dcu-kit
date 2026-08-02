/**
 * Live Preprod: governance at a quorum ABOVE ONE.
 *
 * Every governance proof so far ran at quorum=1 with a single voter, which
 * cannot distinguish "the threshold logic works" from "the threshold was
 * trivially met". This raises the existing instance to quorum=2 (via
 * updateCharter, so no new instance and no fresh ~85 ADA of reference scripts)
 * and runs TWO proposals against the same deadline:
 *
 *   Proposal A: only USER1 votes  -> must NOT pass
 *   Proposal B: USER1 and USER2 vote -> must pass
 *
 * The failing one is the point. A quorum that passes when it should is
 * indistinguishable from no quorum check at all; the proof is the proposal that
 * falls one vote short and is refused.
 *
 * Both proposals share one deadline so the run costs one wait, not two.
 *
 * Usage: from sdk/,
 *   npx tsx examples/roundtrip-governance-quorum.mjs --seed <tx>#<i> \
 *     --refs <tx>#<i>,<tx>#<i> --fund <fundTokenName>
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { buildGovernance } from "../src/governance/validators.js";
import { unsignedUpdateCharterTxProgram } from "../src/governance/endpoints/updateCharter.js";
import { unsignedRegisterVoterTxProgram } from "../src/governance/endpoints/registerVoter.js";
import { unsignedSplitEligibilityTxProgram } from "../src/governance/endpoints/splitEligibility.js";
import { unsignedOpenProposalTxProgram } from "../src/governance/endpoints/openProposal.js";
import { unsignedCastVoteTxProgram } from "../src/governance/endpoints/castVote.js";
import { unsignedFinalizeProposalTxProgram } from "../src/governance/endpoints/finalizeProposal.js";
import {
  govActionForOperation,
  SavingsOperation,
} from "../src/governance/utils.js";
import { unsignedJoinFundTxProgram } from "../src/savings/endpoints/joinFund.js";
import { getFundMembersProgram } from "../src/savings/queries/getFundMembers.js";
import { savingsPolicyId } from "../src/savings/validators.js";
import { assetNameLabels } from "../src/core/utils/index.js";
import manifest from "../src/core/deployments/preprod.json" with { type: "json" };

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const parseOutRef = (s) => {
  const [txHash, index] = s.split("#");
  return { txHash, outputIndex: Number(index) };
};

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
const asUser1 = () => lucid.selectWallet.fromSeed(env.USER1_SEED);
const asUser2 = () => lucid.selectWallet.fromSeed(env.USER2_SEED);
asUser1();

const settle = () => new Promise((r) => setTimeout(r, 75_000));
const retry = async (label, fn, attempts = 4) => {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient = /fetch failed|socket|ECONN|timeout|502|503|504|OutsideValidityInterval/i.test(
        String(e?.message ?? e),
      );
      if (!transient || i === attempts) throw e;
      console.log(`  (${label} attempt ${i} failed, retrying: ${e.message})`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
};
const run = (label, program) => retry(label, () => Effect.runPromise(program));
const submit = async (tx, label) => {
  const hash = await retry(label, async () => {
    const signed = await tx.sign.withWallet().complete();
    return signed.submit();
  });
  console.log(`${label}: ${hash}`);
  await retry(`${label} confirm`, () => lucid.awaitTx(hash));
  await settle();
  return hash;
};
const now = () => BigInt(Date.now()) - 60_000n;

const seed =
  arg("--seed") ??
  `${manifest.governance.seed.txHash}#${manifest.governance.seed.outputIndex}`;
const instance = buildGovernance(parseOutRef(seed));
const fundTokenName = arg("--fund") ?? manifest.governance.governedFund;
console.log("instance gate:", instance.gateHash);
console.log("governed fund:", fundTokenName);

const refsArg = arg("--refs");
const refPair = refsArg
  ? refsArg.split(",").map(parseOutRef)
  : [
      {
        txHash: manifest.refScripts.governanceDispatcher.txHash,
        outputIndex: manifest.refScripts.governanceDispatcher.outputIndex,
      },
      {
        txHash: manifest.refScripts.governanceVoting.txHash,
        outputIndex: manifest.refScripts.governanceVoting.outputIndex,
      },
    ];
const resolveRef = async (outRef) => {
  const utxos = await lucid.utxosByOutRef([outRef]);
  const found = utxos.find(
    (u) => u.txHash === outRef.txHash && u.outputIndex === outRef.outputIndex,
  );
  if (!found?.scriptRef) throw new Error(`no script at ${outRef.txHash}`);
  return found;
};
const scriptRefs = {
  dispatcher: await resolveRef(refPair[0]),
  voting: await resolveRef(refPair[1]),
};

const savingsRefEntry = manifest.refScripts.savings;
const [savingsRef] = await lucid.utxosByOutRef([
  {
    txHash: savingsRefEntry.txHash,
    outputIndex: savingsRefEntry.outputIndex,
  },
]);

const unitOf = (suffix) => savingsPolicyId + assetNameLabels.prefix222 + suffix;
/** The voter input must hold exactly one name under member_policy, and ordinary
 *  change handling re-merges them after every tx, so this runs before each
 *  voter-token call rather than once. */
const splitFor = async (unit, label) => {
  const tx = await run(
    "splitEligibility",
    unsignedSplitEligibilityTxProgram(lucid, { tokenUnits: [unit] }),
  );
  await submit(tx, `splitEligibility (${label})`);
};

// 1. Raise the bar. quorum is a mutable charter field, so the existing instance
//    can be reused: a fresh one would cost ~85 ADA in permanent deposits.
const charterTx = await run(
  "updateCharter",
  unsignedUpdateCharterTxProgram(lucid, {
    instance,
    governedTargets: [[savingsPolicyId, fundTokenName]],
    quorum: 2n,
  }),
);
await submit(charterTx, "updateCharter (quorum 1 -> 2)");

// 2. Find or create the two voters. USER1 is already a member of the governed
//    fund; USER2 joins it so there is a second eligible token.
const members = await run(
  "getFundMembers",
  getFundMembersProgram(lucid, fundTokenName),
);
const heldBy = async (suffix) => {
  const address = await lucid.wallet().address();
  const utxos = await retry("utxosAtWithUnit", () =>
    lucid.utxosAtWithUnit(address, unitOf(suffix)),
  );
  return utxos.length > 0;
};
let s1, s2;
for (const m of members) {
  asUser1();
  if (await heldBy(m.memberTokenSuffix)) {
    s1 = m.memberTokenSuffix;
    continue;
  }
  asUser2();
  if (await heldBy(m.memberTokenSuffix)) s2 = m.memberTokenSuffix;
}
if (!s1) throw new Error("USER1 holds no member token in the governed fund");
if (!s2) {
  asUser2();
  const { tx: joinTx, memberTokenSuffix } = await run(
    "joinFund USER2",
    unsignedJoinFundTxProgram(lucid, {
      scriptRef: savingsRef,
      fundTokenName,
      consent: true,
    }),
  );
  await submit(joinTx, "joinFund (USER2, second voter)");
  s2 = memberTokenSuffix;
}
console.log("voter tokens:", s1.slice(0, 12), s2.slice(0, 12));

// 3. Register USER2 as the second voter (USER1 already registered).
asUser2();
await splitFor(unitOf(s2), "USER2");
const reg = await Effect.runPromise(
  unsignedRegisterVoterTxProgram(lucid, {
    instance,
    voterTokenUnit: unitOf(s2),
    scriptRefs,
  }).pipe(Effect.either),
);
if (reg._tag === "Right") {
  await submit(reg.right.tx, "registerVoter (USER2)");
} else {
  console.log("registerVoter (USER2): already registered, continuing");
}

// 4. Two proposals, one shared deadline.
const deadline = now() + 900_000n;
asUser1();
await splitFor(unitOf(s1), "USER1");
const { tx: openA, proposalId: idA } = await run(
  "openProposal A",
  unsignedOpenProposalTxProgram(lucid, {
    instance,
    targetPolicy: savingsPolicyId,
    targetId: fundTokenName,
    action: govActionForOperation(SavingsOperation.UpdateFund),
    deadline,
    openerTokenUnit: unitOf(s1),
    currentTime: now(),
    scriptRefs,
  }),
);
await submit(openA, "openProposal A (will get ONE vote)");

await splitFor(unitOf(s1), "USER1");
const { tx: openB, proposalId: idB } = await run(
  "openProposal B",
  unsignedOpenProposalTxProgram(lucid, {
    instance,
    targetPolicy: savingsPolicyId,
    targetId: fundTokenName,
    action: govActionForOperation(SavingsOperation.UpdateFund),
    deadline,
    openerTokenUnit: unitOf(s1),
    currentTime: now(),
    scriptRefs,
  }),
);
await submit(openB, "openProposal B (will get TWO votes)");

// 5. Vote. A gets one, B gets both.
await splitFor(unitOf(s1), "USER1");
const { tx: voteA1 } = await run(
  "castVote A USER1",
  unsignedCastVoteTxProgram(lucid, {
    instance,
    proposalId: idA,
    approve: true,
    voterTokenUnit: unitOf(s1),
    currentTime: now(),
    scriptRefs,
  }),
);
await submit(voteA1, "castVote A (USER1 only)");

await splitFor(unitOf(s1), "USER1");
const { tx: voteB1 } = await run(
  "castVote B USER1",
  unsignedCastVoteTxProgram(lucid, {
    instance,
    proposalId: idB,
    approve: true,
    voterTokenUnit: unitOf(s1),
    currentTime: now(),
    scriptRefs,
  }),
);
await submit(voteB1, "castVote B (USER1)");

asUser2();
await splitFor(unitOf(s2), "USER2");
const { tx: voteB2 } = await run(
  "castVote B USER2",
  unsignedCastVoteTxProgram(lucid, {
    instance,
    proposalId: idB,
    approve: true,
    voterTokenUnit: unitOf(s2),
    currentTime: now(),
    scriptRefs,
  }),
);
await submit(voteB2, "castVote B (USER2, second vote)");

// 6. Wait out the shared deadline, then finalize both.
const waitMs = Number(deadline - BigInt(Date.now())) + 90_000;
if (waitMs > 0) {
  console.log(`waiting ${Math.ceil(waitMs / 1000)}s for the deadline...`);
  await new Promise((r) => setTimeout(r, waitMs));
}

asUser1();
const { tx: finA, passed: passedA } = await run(
  "finalize A",
  unsignedFinalizeProposalTxProgram(lucid, {
    instance,
    proposalId: idA,
    currentTime: now(),
    scriptRefs,
  }),
);
console.log("  proposal A passed:", passedA, "(expected false, 1 of 2)");
await submit(finA, "finalizeProposal A");

const { tx: finB, passed: passedB } = await run(
  "finalize B",
  unsignedFinalizeProposalTxProgram(lucid, {
    instance,
    proposalId: idB,
    currentTime: now(),
    scriptRefs,
  }),
);
console.log("  proposal B passed:", passedB, "(expected true, 2 of 2)");
await submit(finB, "finalizeProposal B");

if (passedA !== false) {
  throw new Error(
    "QUORUM NOT ENFORCED: a proposal with 1 of 2 required votes passed",
  );
}
if (passedB !== true) {
  throw new Error("a proposal meeting quorum 2 failed to pass");
}
console.log(
  "\nQUORUM ROUND TRIP COMPLETE: one vote short is REFUSED, two votes carry." +
    " The threshold is enforced, not decorative.",
);
