/**
 * Preprod teardown, phase 3: dissolve every savings fund whose quorum is a key
 * we hold, then release the member accounts that outlived their funds.
 *
 * Per fund: closeCycle (quorum freezes the share-out) → each member claims
 * their own share → closeFund (quorum burns the anchor) → each member exits.
 * Claims are member-pulled, so the wallet switches per member.
 *
 * The two governance-gated funds are deliberately untouched: closing them needs
 * a governance decision per operation, about 15 transactions each to recover
 * 2 ADA. The fund whose quorum is the unrecoverable gate 3a650d1d… is untouched
 * too, but its member account is released, since exitFund does not need a live
 * anchor.
 *
 * Usage: from sdk/, `npx tsx examples/teardown-savings.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { unsignedCloseCycleTxProgram } from "../src/savings/endpoints/closeCycle.js";
import { unsignedClaimShareOutTxProgram } from "../src/savings/endpoints/claimShareOut.js";
import { unsignedCloseFundTxProgram } from "../src/savings/endpoints/closeFund.js";
import { unsignedExitFundTxProgram } from "../src/savings/endpoints/exitFund.js";
import { getFundStateProgram } from "../src/savings/queries/getFundState.js";
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
const use = (name) =>
  lucid.selectWallet.fromSeed(env[`${name}_SEED`], { accountIndex: 0 });

const settle = (s = 45) => new Promise((r) => setTimeout(r, s * 1000));
const [scriptRef] = await lucid.utxosByOutRef([
  {
    txHash: manifest.refScripts.savings.txHash,
    outputIndex: manifest.refScripts.savings.outputIndex,
  },
]);

const log = [];
const run = async (label, program) => {
  const built = await Effect.runPromise(Effect.either(program));
  if (built._tag !== "Right") {
    console.log(`  ${label}: BUILD FAILED ${String(built.left).slice(0, 220)}`);
    log.push([label, "build-failed"]);
    return false;
  }
  try {
    const signed = await built.right.sign.withWallet().complete();
    const hash = await signed.submit();
    console.log(`  ${label}: ${hash}`);
    await lucid.awaitTx(hash);
    await settle();
    log.push([label, hash]);
    return true;
  } catch (e) {
    console.log(`  ${label}: SUBMIT FAILED ${String(e).slice(0, 220)}`);
    log.push([label, "submit-failed"]);
    return false;
  }
};

// fund → quorum wallet, and the members that must claim and then exit.
const FUNDS = [
  {
    id: "519b24fca568f8cd319c254dba4b9fdb5ff0c71c59170f1f51a6eee0c7e432c4",
    title: "Welfare fund (empty)",
    quorum: "USER1",
    members: [],
  },
  {
    id: "eb995bdfa3bb4df2ed50c4e595b8ff4d94414c23005007822063bd13b90c47d6",
    title: "Preprod credit fund",
    quorum: "USER1",
    members: [
      { suffix: "5b4be5c710a08256763030f19bb890fb01fc68028511e0db8ddd9422", wallet: "USER1" },
      { suffix: "1375c245eb83b06e010ec3c1feb277a42e8faf964338f1eafbaf504f", wallet: "USER2" },
    ],
  },
  {
    id: "2fadf9d9801c89c8dd1a3e4a8b781d7775aa4d5ae37e6cb108d78fb514aa3da7",
    title: "ASCA flexible fund",
    quorum: "USER1",
    members: [
      { suffix: "436398fa50a4668c9d6f761bffa82d509fe206f4d421ed6c8589b0eb", wallet: "USER1" },
    ],
  },
  {
    id: "6e1f67ecc2f06318423e08d51d782188cff6df432d99cfa3442e2e19154eefa0",
    title: "Welfare fund (funded)",
    quorum: "USER1",
    members: [
      { suffix: "8b277b0c3d586bc21c5b560bbf8a34038983b79be85cf69168d0d4e7", wallet: "USER1" },
    ],
  },
];

// Member accounts whose fund is already gone, or unreachable, released on their own.
const ORPHANS = [
  { suffix: "4e6eb5babdd8b4035896d897f035e5fb3ac128a555ebcc3ba908b4f4", wallet: "USER1" },
  { suffix: "04338e78568e2c4e37c75937d31daaab009d7a88e949ad13d733b929", wallet: "USER1" },
  { suffix: "a84179b714c04e4aaed5f721a1e39fade08c0ca7bc7767a99123d6f6", wallet: "USER2" },
  { suffix: "803bf51f395804e60090c7d00d3a7c17e7feef20586adc938ab9d786", wallet: "USER2" },
  // member of fund 7fec9b66…, whose quorum gate can never be rebuilt
  { suffix: "78c8658542c820afb2360f70a67ec7004114209cd1a91cba424732da", wallet: "USER1" },
];

for (const fund of FUNDS) {
  console.log(`\n=== ${fund.title}  ${fund.id.slice(0, 12)}…`);
  const before = await Effect.runPromise(
    Effect.either(getFundStateProgram(lucid, fund.id)),
  );
  if (before._tag !== "Right") {
    console.log(`  skipped, no live anchor: ${String(before.left).slice(0, 120)}`);
    continue;
  }
  console.log(
    `  status=${before.right.fund.status} shares=${before.right.fund.shares_total} vault=${Number(before.right.vaultBalance) / 1e6}`,
  );

  if (before.right.fund.status === "Active") {
    use(fund.quorum);
    await run(
      "closeCycle",
      unsignedCloseCycleTxProgram(lucid, {
        scriptRef,
        fundTokenName: fund.id,
        currentTime: BigInt(Date.now()) - 120_000n,
      }),
    );
  }

  for (const m of fund.members) {
    use(m.wallet);
    await run(
      `claimShareOut ${m.wallet}`,
      unsignedClaimShareOutTxProgram(lucid, {
        scriptRef,
        fundTokenName: fund.id,
        memberTokenSuffix: m.suffix,
      }),
    );
  }

  use(fund.quorum);
  await run(
    "closeFund",
    unsignedCloseFundTxProgram(lucid, { scriptRef, fundTokenName: fund.id }),
  );

  for (const m of fund.members) {
    use(m.wallet);
    await run(
      `exitFund ${m.wallet}`,
      unsignedExitFundTxProgram(lucid, {
        scriptRef,
        memberTokenSuffix: m.suffix,
      }),
    );
  }
}

console.log("\n=== orphan member accounts");
for (const m of ORPHANS) {
  use(m.wallet);
  await run(
    `exitFund ${m.wallet} ${m.suffix.slice(0, 10)}…`,
    unsignedExitFundTxProgram(lucid, {
      scriptRef,
      memberTokenSuffix: m.suffix,
    }),
  );
}

console.log("\n=== summary");
for (const [label, result] of log) console.log(`  ${label.padEnd(28)} ${result}`);
