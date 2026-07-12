/**
 * Mint Governance Sweep Tokens (setup helper)
 *
 * Governance is deliberately agnostic about WHERE eligibility comes from: the
 * charter names a `member_policy`, and holding any token of it makes a voter. In
 * production that policy is the savings user-token policy (so savers vote). For a
 * standalone Preprod sweep we mint the two tokens governance needs under a simple
 * permissionless native policy:
 *
 *   - an ELIGIBILITY token  → the opener/voter spends it to prove membership
 *   - a TARGET VAULT token  → a token NAMED the governed target id; the gate binds
 *                             a decision to the input that carries it
 *
 * Both units are written to state.json for the rest of the governance scripts.
 *
 * Usage:
 *   pnpm run governance-mint-tokens
 */

import {
  fromText,
  mintingPolicyToId,
  scriptFromNative,
} from "@lucid-evolution/lucid";
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

  // A permissionless native policy — anyone may mint. Fine for a sweep; in
  // production the eligibility policy is the savings user-token policy.
  const script = scriptFromNative({ type: "all", scripts: [] });
  const policy = mintingPolicyToId(script);

  const memberName = fromText(process.env.MEMBER_NAME ?? "member");
  // The governed vault's state-token NAME is the proposal's target_id.
  const targetName = fromText(process.env.TARGET_NAME ?? "vault");

  const memberUnit = policy + memberName;
  const targetUnit = policy + targetName;

  console.log("Minting governance sweep tokens under native policy:", policy);
  console.log("  eligibility token:", memberUnit);
  console.log("  target vault token:", targetUnit);

  const tx = await lucid
    .newTx()
    .mintAssets({ [memberUnit]: 1n, [targetUnit]: 1n })
    .attach.MintingPolicy(script)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  saveState({
    governanceMemberUnit: memberUnit,
    governanceTargetUnit: targetUnit,
  });

  console.log("\nTokens minted. Now run governance-init with:");
  console.log(`  MEMBER_POLICY=${policy}`);
  console.log(`  GOVERNED_TARGETS=${targetName}`);
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
