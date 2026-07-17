/**
 * Negative-Proof Runner — matrix C validator proofs on a live deployment.
 *
 * Builds transactions the validators must reject (via @tx-meta/dcu-kit/harness)
 * and records each rejection as an evidence JSON file: evaluator error, the
 * attempted datum, the deployment identity, a timestamp, and confirmation the
 * seed UTxO stayed unspent. Nothing is ever signed or submitted — proofs stop
 * at provider evaluation (localUPLCEval: false for the raw builders).
 *
 * Cases and their fixtures:
 *   C1 C2 C3  create-group below the config-safety envelope — funded wallet only
 *   C4 C5     pre-join update-group (sub-floor timelock / version / empty name)
 *             — needs a PRE-JOIN group; wallet must hold the group admin (222)
 *   C6        create-account with a 31-byte commitment — funded wallet only
 *   C7        premature execute-recovery — pending recovery, timelock unexpired;
 *             recoveree wallet + TARGET_SUFFIX env (same contract as
 *             execute-recovery.ts)
 *   C8        premature re-seal (start-group during an open recommit window) —
 *             admin wallet
 *   C9        join beyond max_members — joining wallet with an account token;
 *             group already full
 *
 * Usage:
 *   npx tsx negative-proofs.ts C1 C2 C3 C6
 *   GROUP_TOKEN_SUFFIX=... npx tsx negative-proofs.ts C4 C5
 *   TARGET_SUFFIX=... ACTIVE_WALLET=USER2 npx tsx negative-proofs.ts C7
 *
 * Evidence: examples/evidence/negative-proofs/<case>-<timestamp>.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Effect } from "effect";
import {
  LucidEvolution,
  OutRef,
  paymentCredentialOf,
} from "@lucid-evolution/lucid";
import {
  GroupDatum,
  assetNameLabels,
  parseGroupCip68Datum,
  patchInlineDatum,
  resolveUtxoByUnit,
} from "@tx-meta/dcu-kit";
import {
  captureRejection,
  deploymentIdentity,
  rawCreateAccount,
  rawCreateGroup,
  rawUpdateGroup,
  RejectionEvidence,
} from "@tx-meta/dcu-kit/harness";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  selectEnvWallet,
  loadScriptRefs,
  discoverAccountSuffix,
  logError,
} from "./context.js";
import { loadState } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.join(__dirname, "evidence", "negative-proofs");

const FLOOR = 86_400_000n; // min_recovery_timelock == min_recommit_window (1 day)

function writeEvidence(caseId: string, evidence: RejectionEvidence): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(
    EVIDENCE_DIR,
    `${caseId}-${evidence.timestamp.replace(/[:.]/g, "-")}.json`,
  );
  fs.writeFileSync(
    file,
    JSON.stringify(
      evidence,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
  console.log(`  ✓ ${evidence.label}`);
  console.log(`    evidence: ${path.relative(process.cwd(), file)}`);
  return file;
}

/** Envelope-valid base datum for the create-group proofs — each case breaks
 *  exactly ONE field of an otherwise acceptable configuration. */
function baseGroupDatum(adminPkh: string): GroupDatum {
  return {
    contribution_fee_policyid: "",
    contribution_fee_assetname: "",
    contribution_fee: 2_000_000n,
    joining_fee_policyid: "",
    joining_fee_assetname: "",
    joining_fee: 0n,
    penalty_fee_policyid: "",
    penalty_fee_assetname: "",
    penalty_fee: 2_000_000n,
    creator_bond: 0n,
    interval_length: 3_600_000n,
    num_rounds: 0n,
    max_members: 5n,
    collateral_rounds: 1n,
    payout_mode: "Push",
    recovery_threshold: 3n,
    recovery_timelock: FLOOR,
    member_count: 0n,
    active_member_count: 0n,
    member_slots: [],
    era_start_round: 0n,
    recommit_window: FLOOR,
    reserve_join_levy: 0n,
    reserve_round_levy: 0n,
    is_active: true,
    is_started: false,
    start_time: 0n,
    last_distributed_round: -1n,
    grace_period_length: 0n,
    creator_payment_credential: { VerificationKey: [adminPkh] },
    member_token_names: [],
  };
}

async function spendableSeed(lucid: LucidEvolution): Promise<OutRef> {
  const utxos = await lucid.wallet().getUtxos();
  const seed = utxos.filter(
    (u) => !u.scriptRef && u.assets.lovelace > 5_000_000n,
  )[0];
  if (!seed) throw new Error("No spendable UTxO (>5 ADA) in the wallet");
  return { txHash: seed.txHash, outputIndex: seed.outputIndex };
}

function requireGroupSuffix(): string {
  const suffix = process.env.GROUP_TOKEN_SUFFIX ?? loadState().groupTokenSuffix;
  if (!suffix)
    throw new Error(
      "No groupTokenSuffix in state.json (and GROUP_TOKEN_SUFFIX not set).",
    );
  return suffix;
}

async function currentGroupDatum(
  lucid: LucidEvolution,
  groupPolicyId: string,
  suffix: string,
): Promise<GroupDatum> {
  const unit = groupPolicyId + assetNameLabels.prefix100 + suffix;
  const utxo = patchInlineDatum(
    await Effect.runPromise(resolveUtxoByUnit(lucid, unit)),
  );
  const cip68 = await Effect.runPromise(parseGroupCip68Datum(utxo.datum));
  return cip68.groupDatum;
}

async function main() {
  const cases = process.argv.slice(2).filter((a) => /^C[1-9]$/.test(a));
  if (cases.length === 0) {
    console.log(
      "Usage: npx tsx negative-proofs.ts C1 [C2 C3 C4 C5 C6 C7 C8 C9]",
    );
    process.exit(1);
  }

  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "The live negative proofs need an existing deployment — run on Preprod.\n" +
        "(The emulator verification lives in sdk/test/negativeProofs.test.ts.)",
    );
    process.exit(0);
  }

  const wallet = await selectEnvWallet(lucid, "ADMIN");
  const sdk = loadSdk();
  const protocol = sdk.protocol;
  const network = process.env.NETWORK ?? "Preprod";
  const deployment = deploymentIdentity(protocol, network);
  const scriptRefs = await loadScriptRefs(lucid);
  const address = await lucid.wallet().address();
  const walletPkh = paymentCredentialOf(address).hash;

  console.log(`Negative proofs on ${network} (wallet: ${wallet})`);
  console.log(`Cases: ${cases.join(", ")}\n`);

  const run = (label: string) => async (evidence: Promise<RejectionEvidence>) =>
    writeEvidence(label, await evidence);

  for (const caseId of cases) {
    switch (caseId) {
      case "C1":
      case "C2":
      case "C3": {
        const override: Partial<GroupDatum> =
          caseId === "C1"
            ? { recovery_threshold: 1n }
            : caseId === "C2"
              ? { recovery_timelock: FLOOR - 1n }
              : { recommit_window: 0n };
        const label =
          caseId === "C1"
            ? "C1 create-group recovery_threshold=1"
            : caseId === "C2"
              ? "C2 create-group recovery_timelock=86_399_999"
              : "C3 create-group recommit_window=0";
        const seed = await spendableSeed(lucid);
        const { attemptedDatum, program } = rawCreateGroup(protocol, lucid, {
          groupDatum: { ...baseGroupDatum(walletPkh), ...override },
          utxoToSpend: seed,
          scriptRefs,
          localUPLCEval: false,
        });
        await run(caseId)(
          Effect.runPromise(
            captureRejection(
              lucid,
              {
                label,
                deployment,
                evaluation: "provider",
                attemptedDatum,
                seedOutRef: seed,
              },
              program,
            ),
          ),
        );
        break;
      }

      case "C4":
      case "C5": {
        const suffix = requireGroupSuffix();
        const datum = await currentGroupDatum(
          lucid,
          protocol.groupPolicyId,
          suffix,
        );
        const variants =
          caseId === "C4"
            ? [
                {
                  label: "C4 pre-join update recovery_timelock=86_399_999",
                  params: {
                    updatedDatum: { ...datum, recovery_timelock: FLOOR - 1n },
                  },
                },
              ]
            : [
                {
                  label: "C5 pre-join update version=2",
                  params: { updatedDatum: datum, versionOverride: 2n },
                },
                {
                  label: "C5 pre-join update empty metadata",
                  params: {
                    updatedDatum: datum,
                    metadataOverride: new Map<string, string>(),
                  },
                },
              ];
        for (const variant of variants) {
          const { attemptedDatum, program } = await Effect.runPromise(
            rawUpdateGroup(protocol, lucid, {
              groupTokenSuffix: suffix,
              localUPLCEval: false,
              ...variant.params,
            }),
          );
          await run(caseId)(
            Effect.runPromise(
              captureRejection(
                lucid,
                {
                  label: variant.label,
                  deployment,
                  evaluation: "provider",
                  attemptedDatum,
                },
                program,
              ),
            ),
          );
        }
        break;
      }

      case "C6": {
        const seed = await spendableSeed(lucid);
        const { attemptedDatum, program } = rawCreateAccount(protocol, lucid, {
          selected_out_ref: seed,
          profileCommitmentHex: "ab".repeat(31),
          localUPLCEval: false,
        });
        await run(caseId)(
          Effect.runPromise(
            captureRejection(
              lucid,
              {
                label: "C6 create-account 31-byte commitment",
                deployment,
                evaluation: "provider",
                attemptedDatum,
                seedOutRef: seed,
              },
              program,
            ),
          ),
        );
        break;
      }

      case "C7": {
        // Premature execute-recovery: requires a PENDING recovery whose
        // timelock has not expired, run from the recoveree's wallet.
        const suffix = requireGroupSuffix();
        const targetTokenSuffix = process.env.TARGET_SUFFIX;
        if (!targetTokenSuffix)
          throw new Error("C7 requires TARGET_SUFFIX (the lost identity).");
        const newAccountTokenSuffix =
          process.env.NEW_ACCOUNT_SUFFIX ??
          (await discoverAccountSuffix(lucid));
        if (!newAccountTokenSuffix)
          throw new Error(
            "C7: no account (222) token in this wallet — run from the recoveree's wallet.",
          );
        await run(caseId)(
          Effect.runPromise(
            captureRejection(
              lucid,
              {
                label: "C7 premature execute-recovery",
                deployment,
                evaluation: "local-uplc",
              },
              sdk
                .executeRecovery(lucid, {
                  groupTokenSuffix: suffix,
                  targetTokenSuffix,
                  newAccountTokenSuffix,
                  scriptRefs,
                })
                .program(),
            ),
          ),
        );
        break;
      }

      case "C8": {
        // Premature re-seal: start-group while the recommit window is open.
        const suffix = requireGroupSuffix();
        await run(caseId)(
          Effect.runPromise(
            captureRejection(
              lucid,
              {
                label: "C8 premature re-seal (recommit window open)",
                deployment,
                evaluation: "local-uplc",
              },
              sdk
                .startGroup(lucid, { groupTokenSuffix: suffix, scriptRefs })
                .program(),
            ),
          ),
        );
        break;
      }

      case "C9": {
        // Join beyond max_members: the group must already be full.
        const suffix = requireGroupSuffix();
        const accountTokenSuffix =
          process.env.ACCOUNT_SUFFIX ?? (await discoverAccountSuffix(lucid));
        if (!accountTokenSuffix)
          throw new Error(
            "C9: no account (222) token in this wallet — join needs an account.",
          );
        await run(caseId)(
          Effect.runPromise(
            captureRejection(
              lucid,
              {
                label: "C9 join beyond max_members",
                deployment,
                evaluation: "local-uplc",
              },
              sdk
                .joinGroup(lucid, {
                  groupTokenSuffix: suffix,
                  accountTokenSuffix,
                  scriptRefs,
                })
                .program(),
            ),
          ),
        );
        break;
      }
    }
  }

  console.log("\nAll requested proofs captured.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
