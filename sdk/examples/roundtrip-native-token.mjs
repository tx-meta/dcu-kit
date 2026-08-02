/**
 * Live Preprod: a savings fund denominated in a NATIVE TOKEN, not ADA.
 *
 * Every live proof so far has been ADA-denominated, which never exercises the
 * `fundAssetUnit` split: in an ADA fund the members' savings and the UTxO's
 * min-ADA are the same `lovelace` key, so a bug that conflates "the fund's
 * asset" with "the lovelace on the UTxO" is invisible. A token fund separates
 * them: the vault holds min-ADA AND the token, and every deposit, share-out
 * and close must move the token while leaving the min-ADA untouched.
 *
 * This is the USDCx shape from Track A: a 6-decimal stablecoin-like unit where
 * one share is 1.0 token (1_000_000 base units). That is deliberately the same
 * numeric scale as ADA, so a unit-confusion bug cannot hide behind a difference
 * in order of magnitude.
 *
 * Mints its own test token under a native script locked to USER1's key, so it
 * needs no faucet and no external issuer.
 *
 * Usage: from sdk/, `npx tsx examples/roundtrip-native-token.mjs`
 */
import { readFileSync } from "node:fs";
import {
  Lucid,
  Blockfrost,
  fromText,
  scriptFromNative,
  mintingPolicyToId,
  getAddressDetails,
  walletFromSeed,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { unsignedCreateFundTxProgram } from "../src/savings/endpoints/createFund.js";
import { unsignedJoinFundTxProgram } from "../src/savings/endpoints/joinFund.js";
import { unsignedDepositTxProgram } from "../src/savings/endpoints/deposit.js";
import { unsignedCloseCycleTxProgram } from "../src/savings/endpoints/closeCycle.js";
import { unsignedClaimShareOutTxProgram } from "../src/savings/endpoints/claimShareOut.js";
import { unsignedCloseFundTxProgram } from "../src/savings/endpoints/closeFund.js";
import { getFundStateProgram } from "../src/savings/queries/getFundState.js";
import { GroupType } from "../src/savings/types.js";
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
const asUser1 = () => lucid.selectWallet.fromSeed(env.USER1_SEED);
const asUser2 = () => lucid.selectWallet.fromSeed(env.USER2_SEED);
asUser1();

const settle = () => new Promise((r) => setTimeout(r, 75_000));
/** A dropped socket is transient; a validator rejection is not. */
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
const balanceOf = async (unit) => {
  const address = await lucid.wallet().address();
  const utxos = await retry("utxosAt", () => lucid.utxosAt(address));
  return utxos.reduce((sum, u) => sum + (u.assets[unit] ?? 0n), 0n);
};

const user1Address = await lucid.wallet().address();
const user2Address = walletFromSeed(env.USER2_SEED, {
  network: "Preprod",
}).address;

// --- 1. Mint the test token -------------------------------------------------
// A native "sig" script locked to USER1's key: no plutus, nothing to deploy,
// and the policy id is derived from the script so it is stable across runs.
const mintingPolicy = scriptFromNative({
  type: "sig",
  keyHash: getAddressDetails(user1Address).paymentCredential.hash,
});
const policyId = mintingPolicyToId(mintingPolicy);
const assetName = fromText("USDCx");
const tokenUnit = policyId + assetName;
console.log("USDCx unit:", tokenUnit);

// 30.0 USDCx, two members' shares plus headroom. Skipped if a previous run
// already minted (the policy is deterministic, so the tokens are still here).
const held = await balanceOf(tokenUnit);
if (held < 20_000_000n) {
  const mintTx = await retry("mint", () =>
    lucid
      .newTx()
      .mintAssets({ [tokenUnit]: 30_000_000n })
      .attach.MintingPolicy(mintingPolicy)
      .addSigner(user1Address)
      .complete(),
  );
  await submit(mintTx, "mint 30.0 USDCx");
} else {
  console.log(`  already holding ${held} base units, skipping the mint`);
}

// USER2 needs their own tokens to deposit with, plus ADA for fees and min-ADA.
const user2Held = await (async () => {
  asUser2();
  const b = await balanceOf(tokenUnit);
  asUser1();
  return b;
})();
if (user2Held < 4_000_000n) {
  const fundTx = await retry("fund USER2", () =>
    lucid
      .newTx()
      .pay.ToAddress(user2Address, {
        lovelace: 10_000_000n,
        [tokenUnit]: 8_000_000n,
      })
      .complete(),
  );
  await submit(fundTx, "send USER2 8.0 USDCx + 10 ADA");
} else {
  console.log(`  USER2 already holds ${user2Held} base units`);
}

// --- 2. The fund, denominated in the token ----------------------------------
const r = manifest.refScripts.savings;
const [scriptRef] = await lucid.utxosByOutRef([
  { txHash: r.txHash, outputIndex: r.outputIndex },
]);

const show = async (fundTokenName, label) => {
  const s = await run(
    "getFundState",
    getFundStateProgram(lucid, fundTokenName),
  );
  console.log(
    `  ${label}: phase=${s.phase} shares_total=${s.fund.shares_total}` +
      ` savings_total=${s.fund.savings_total} vaultBalance=${s.vaultBalance}`,
  );
  return s;
};

const { tx: createTx, fundTokenName } = await run(
  "createFund",
  unsignedCreateFundTxProgram(lucid, {
    scriptRef,
    title: "USDCx savings fund",
    groupType: GroupType.Vsla,
    shareValue: 1_000_000n, // 1.0 USDCx per share
    minSharesPerDeposit: 1n,
    maxSharesPerDeposit: 100n,
    withdrawalPolicy: 0n,
    maxLoanMultiple: 0n,
    assetPolicy: policyId,
    assetName,
  }),
);
await submit(createTx, "createFund (USDCx-denominated)");
console.log("  fundTokenName:", fundTokenName);

const { tx: joinTx, memberTokenSuffix } = await run(
  "joinFund",
  unsignedJoinFundTxProgram(lucid, { scriptRef, fundTokenName, consent: true }),
);
await submit(joinTx, "joinFund (USER1)");

const depositTx = await run(
  "deposit",
  unsignedDepositTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix,
    fundTag: 0n, // buy shares
    units: 6n, // 6.0 USDCx
  }),
);
await submit(depositTx, "deposit (USER1, 6 shares = 6.0 USDCx)");

asUser2();
const { tx: join2Tx, memberTokenSuffix: member2 } = await run(
  "joinFund USER2",
  unsignedJoinFundTxProgram(lucid, { scriptRef, fundTokenName, consent: true }),
);
await submit(join2Tx, "joinFund (USER2)");

const deposit2Tx = await run(
  "deposit USER2",
  unsignedDepositTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix: member2,
    fundTag: 0n,
    units: 3n, // 3.0 USDCx
  }),
);
await submit(deposit2Tx, "deposit (USER2, 3 shares = 3.0 USDCx)");

asUser1();
const funded = await show(fundTokenName, "after both deposits");
if (funded.fund.shares_total !== 9n) {
  throw new Error(`expected 9 shares, got ${funded.fund.shares_total}`);
}
// THE POINT: the members' money is the TOKEN. `savings_total` is denominated in
// the token, and the vault's lovelace is min-ADA that no member ever deposited.
if (funded.fund.savings_total !== 9_000_000n) {
  throw new Error(
    `savings_total should be 9.0 USDCx in base units, got ${funded.fund.savings_total}`,
  );
}

// --- 3. Close the cycle and let each member pull their own token share-out ---
const closeCycleTx = await run(
  "closeCycle",
  unsignedCloseCycleTxProgram(lucid, { scriptRef, fundTokenName }),
);
await submit(closeCycleTx, "closeCycle");
await show(fundTokenName, "after closeCycle");

const before1 = await balanceOf(tokenUnit);
const claimTx = await run(
  "claimShareOut",
  unsignedClaimShareOutTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix,
  }),
);
await submit(claimTx, "claimShareOut (USER1, 6/9)");
const after1 = await balanceOf(tokenUnit);
console.log(`  USER1 USDCx: ${before1} → ${after1} (+${after1 - before1})`);
if (after1 - before1 !== 6_000_000n) {
  throw new Error(
    `USER1 should have received 6.0 USDCx, got ${after1 - before1}`,
  );
}

asUser2();
const before2 = await balanceOf(tokenUnit);
const claim2Tx = await run(
  "claimShareOut USER2",
  unsignedClaimShareOutTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix: member2,
  }),
);
await submit(claim2Tx, "claimShareOut (USER2, 3/9, non-creator)");
const after2 = await balanceOf(tokenUnit);
console.log(`  USER2 USDCx: ${before2} → ${after2} (+${after2 - before2})`);
if (after2 - before2 !== 3_000_000n) {
  throw new Error(
    `USER2 should have received 3.0 USDCx, got ${after2 - before2}`,
  );
}

asUser1();
const drained = await show(fundTokenName, "after both claims");
if (drained.fund.status.SharingOut?.shares_remaining !== 0n) {
  throw new Error(
    `shares still unclaimed: ${drained.fund.status.SharingOut?.shares_remaining}`,
  );
}

const closeFundTx = await run(
  "closeFund",
  unsignedCloseFundTxProgram(lucid, { scriptRef, fundTokenName }),
);
await submit(closeFundTx, "closeFund");
console.log(
  "\nNATIVE-TOKEN ROUND TRIP COMPLETE: a USDCx-denominated fund funded," +
    " shared out to two members in tokens, and dissolved.",
);
