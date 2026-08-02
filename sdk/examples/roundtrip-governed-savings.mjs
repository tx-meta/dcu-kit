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
import { buildGovernance } from "../src/governance/validators.js";
import { deployModuleScripts } from "../src/admin/deployModuleScripts.js";
import { unsignedUpdateCharterTxProgram } from "../src/governance/endpoints/updateCharter.js";
import { unsignedRegisterVoterTxProgram } from "../src/governance/endpoints/registerVoter.js";
import { unsignedRegisterVotingStakeTxProgram } from "../src/governance/endpoints/registerVotingStake.js";
import { unsignedSplitEligibilityTxProgram } from "../src/governance/endpoints/splitEligibility.js";
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
import { getFundMembersProgram } from "../src/savings/queries/getFundMembers.js";
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
/** A dropped socket is transient; a validator rejection is not. Retry both a
 *  few times but let the last error surface unchanged. A previous run lost a
 *  whole governance instance to one dropped Blockfrost socket. */
const retry = async (label, fn, attempts = 4) => {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient = /fetch failed|socket|ECONN|timeout|502|503|504/i.test(
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

const ref = async (key) => {
  const e = manifest.refScripts[key];
  const [u] = await lucid.utxosByOutRef([
    { txHash: e.txHash, outputIndex: e.outputIndex },
  ]);
  return u;
};
const savingsRef = await ref("savings");
console.log("savings policy (electorate):", savingsPolicyId);

// 1. Stand up the instance. The electorate IS the savings policy, so voter
//    eligibility and fund identity share one policy — the exact collision the
//    voter-to-fund binding closes.
//
// Resume an existing instance with `--seed <txHash>#<index>`. Standing one up
// costs ~83 ADA in permanent reference-script deposits (below), so a failed
// run is worth resuming rather than replacing.
// Refs already paid for by an interrupted run: `--refs <tx>#<i>,<tx>#<i>`
const refsArg = process.argv.indexOf("--refs");
const parseOutRef = (s) => {
  const [txHash, index] = s.split("#");
  return { txHash, outputIndex: Number(index) };
};
const existingRefs =
  refsArg === -1
    ? {}
    : (([d, v]) => ({ dispatcher: parseOutRef(d), voting: parseOutRef(v) }))(
        process.argv[refsArg + 1].split(","),
      );

const seedArg = process.argv.indexOf("--seed");
let instance;
if (seedArg !== -1) {
  const [txHash, index] = process.argv[seedArg + 1].split("#");
  instance = buildGovernance({ txHash, outputIndex: Number(index) });
  console.log("resuming instance, gateHash:", instance.gateHash);
} else {
  const init = await Effect.runPromise(
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
  instance = init.instance;
  await submit(init.tx, "initGovernance");
  console.log("  gateHash:", instance.gateHash);
  console.log("  govPolicy:", instance.govPolicy);
}

// Governance validators are parameterised by the instance seed, so EVERY
// instance has its own hashes and needs its OWN reference scripts — the
// manifest's belong to whichever instance deployed them. registerVoter
// witnesses dispatcher (7.6 KB) + voting (10.9 KB), which cannot both ride
// inline under the 16 KB ceiling.
//
// COST: roughly 83 ADA of min-ADA per instance, locked permanently at the
// alwaysFails address. Budget it before spinning up an instance per group.
// Idempotent: a resumed instance reuses the refs it already paid for.
const deployed = await Effect.runPromise(
  deployModuleScripts(
    {
      governanceDispatcher: instance.dispatcherValidator.spend,
      governanceVoting: instance.votingValidator,
    },
    lucid,
    {
      existing: {
        governanceDispatcher: existingRefs.dispatcher,
        governanceVoting: existingRefs.voting,
      },
    },
  ),
);
// deployModuleScripts returns OutRefs; scriptRefs needs resolved UTxOs that
// actually carry the script. utxosByOutRef does not promise to preserve the
// request order, so match each one explicitly.
const resolveRef = async (outRef) => {
  const utxos = await lucid.utxosByOutRef([outRef]);
  const found = utxos.find(
    (u) => u.txHash === outRef.txHash && u.outputIndex === outRef.outputIndex,
  );
  if (!found?.scriptRef) throw new Error(`no script at ${outRef.txHash}`);
  return found;
};
const scriptRefs = {
  dispatcher: await resolveRef(deployed.refs.governanceDispatcher),
  voting: await resolveRef(deployed.refs.governanceVoting),
};
console.log(
  "  refs deployed:",
  scriptRefs.dispatcher.txHash.slice(0, 12),
  scriptRefs.voting.txHash.slice(0, 12),
);
await settle();

// 1b. Register the voting stake credential. EVERY governance endpoint carries a
// 0-ADA withdrawal from the voting validator, and the ledger rejects a
// withdrawal from an unregistered account — so without this one-time tx the
// whole instance is inert (ConwayWithdrawalsMissingAccounts on registerVoter).
// Already-registered is the expected state on a resume, so tolerate it.
try {
  const stakeTx = await run(
    "registerVotingStake",
    unsignedRegisterVotingStakeTxProgram(lucid, instance),
  );
  await submit(stakeTx, "registerVotingStake");
} catch (e) {
  if (!/StakeKeyRegistered|AlreadyRegistered/i.test(String(e?.message ?? e))) {
    throw e;
  }
  console.log("registerVotingStake: already registered, continuing");
}

// 2. The fund's quorum is the gate: no key can amend this charter.
//
// `--fund <tokenName>` resumes a fund an earlier run already created, bound
// and joined. Without it every rerun mints another fund and locks another
// min-ADA, which is pure waste when only a later step failed.
const fundArg = process.argv.indexOf("--fund");
let fundTokenName, memberTokenSuffix;
if (fundArg !== -1) {
  fundTokenName = process.argv[fundArg + 1];
  console.log("resuming fund:", fundTokenName);
  const members = await run(
    "getFundMembers",
    getFundMembersProgram(lucid, fundTokenName),
  );
  const address = await lucid.wallet().address();
  for (const m of members) {
    const unit = savingsPolicyId + assetNameLabels.prefix222 + m.memberTokenSuffix;
    const held = await retry("utxosAtWithUnit", () =>
      lucid.utxosAtWithUnit(address, unit),
    );
    if (held.length > 0) memberTokenSuffix = m.memberTokenSuffix;
  }
  if (!memberTokenSuffix) throw new Error("this wallet holds no member token");
  console.log("  memberTokenSuffix:", memberTokenSuffix);
} else {
  const { tx: fundTx, fundTokenName: minted } = await run(
    "createFund",
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
  fundTokenName = minted;
  await submit(fundTx, "createFund (quorum = the gate)");
  console.log("  fundTokenName:", fundTokenName);

  // 3. Bind the fund as the charter's governed target.
  const charterTx = await run(
    "updateCharter",
    unsignedUpdateCharterTxProgram(lucid, {
      instance,
      governedTargets: [[savingsPolicyId, fundTokenName]],
    }),
  );
  await submit(charterTx, "updateCharter (bind the fund)");

  // 4. Join — the (222) token is eligibility, the (100) account binds the voter
  //    to THIS fund.
  const { tx: joinTx, memberTokenSuffix: joined } = await run(
    "joinFund",
    unsignedJoinFundTxProgram(lucid, {
      scriptRef: savingsRef,
      fundTokenName,
      consent: true,
    }),
  );
  memberTokenSuffix = joined;
  await submit(joinTx, "joinFund");
}
const voterTokenUnit =
  savingsPolicyId + assetNameLabels.prefix222 + memberTokenSuffix;

// The on-chain member-id derivation requires the voter input to hold EXACTLY
// one token name under member_policy. This wallet holds member tokens from
// several savings funds, and ordinary change handling merges them back into one
// UTxO after every transaction — so the split is a prerequisite tx that must be
// re-run immediately before each call that consumes the voter token, not once.
const splitEligibility = async () => {
  const splitTx = await run(
    "splitEligibility",
    unsignedSplitEligibilityTxProgram(lucid, { tokenUnits: [voterTokenUnit] }),
  );
  await submit(splitTx, "splitEligibility (isolate the voter token)");
};

const registeredArg = process.argv.includes("--registered");
if (registeredArg) {
  console.log("voter already registered, skipping registerVoter");
} else {
  await splitEligibility();
  const { tx: regTx } = await run(
    "registerVoter",
  unsignedRegisterVoterTxProgram(lucid, {
    instance,
      voterTokenUnit,
      scriptRefs,
    }),
  );
  await submit(regTx, "registerVoter");
}

// 5. Propose exactly one operation on exactly this fund.
const deadline = now() + 900_000n;
const { tx: openTx, proposalId } = await run(
  "openProposal",
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

await splitEligibility();
const { tx: voteTx } = await run(
  "castVote",
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
const { tx: finTx, passed } = await run(
  "finalizeProposal",
  unsignedFinalizeProposalTxProgram(lucid, {
    instance,
    proposalId,
    currentTime: now(),
    scriptRefs,
  }),
);
console.log("  passed:", passed);
await submit(finTx, "finalizeProposal");

const { tx: execTx, decisionName } = await run(
  "executeDecision",
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
const before = await run(
  "getFundState before",
  getFundStateProgram(lucid, fundTokenName),
);
console.log("  title before:", before.fund.title);

// The gate fragment INDEXES the fund input without collecting it — updateFund
// spends it with its own UpdateFund redeemer, in the same transaction.
const { utxo: fundUtxo } = await run(
  "resolveFund",
  resolveFund(lucid, fundTokenName),
);
const gateWitness = await run(
  "gateWitness",
  gateWitnessProgram(lucid, {
    instance,
    proposalId,
    targetUtxo: fundUtxo,
    scriptRefs,
  }),
);
const amend = await run(
  "updateFund",
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
