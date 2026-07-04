import {
  Network,
  Redeemer,
  RedeemerBuilder,
  TxBuilder,
  UTxO,
  validatorToRewardAddress,
} from "@lucid-evolution/lucid";
import { Protocol, TreasuryFamily } from "./validators/constants.js";
import { ScriptRefs } from "./scripts.js";

// familyWithdraw — the offchain half of the treasury split (spec 2026-07-04).
// ─────────────────────────────────────────────────────────────────────────────
// The treasury dispatcher delegates all heavy validation to four withdraw-zero
// family stake validators (rounds / lifecycle / recovery / reserve). Every
// treasury endpoint therefore:
//   1. spends/mints with a FIELD-LESS TreasuryRedeemer literal (e.g. "ExitGroup"),
//   2. carries a single 0-ADA withdrawal from the family's stake credential whose
//      action redeemer holds the indices + `covered_inputs` (the pin rule), and
//   3. attaches the family stake validator inline unless its reference script is
//      supplied.
// The reward address the withdrawal targets identifies the family on-chain
// (settings publishes the four stake hashes); the dispatcher checks the family
// action covers each spent treasury UTxO.

const REF_KEY: Record<TreasuryFamily, keyof ScriptRefs> = {
  rounds: "treasuryRounds",
  lifecycle: "treasuryLifecycle",
  recovery: "treasuryRecovery",
  reserve: "treasuryReserve",
};

/** Reward (stake) address of a treasury family stake validator. */
export const familyRewardAddress = (
  protocol: Protocol,
  network: Network,
  family: TreasuryFamily,
): string =>
  validatorToRewardAddress(network, protocol.treasuryStakeValidators[family]);

/**
 * Adds the 0-ADA family withdrawal that runs the family action once per tx, and
 * attaches the family stake validator inline unless its reference script is
 * supplied in `refs`. Returns the extended tx builder.
 *
 * @param actionRedeemer - the family action; a {@link RedeemerBuilder} when its
 *   `covered_inputs`/index fields depend on resolved input positions.
 */
export const attachFamilyWithdrawal = (
  tx: TxBuilder,
  protocol: Protocol,
  network: Network,
  family: TreasuryFamily,
  actionRedeemer: RedeemerBuilder | Redeemer,
  refs: ScriptRefs,
): TxBuilder => {
  const withWithdraw = tx.withdraw(
    familyRewardAddress(protocol, network, family),
    0n,
    actionRedeemer,
  );
  const ref = refs[REF_KEY[family]] as UTxO | undefined;
  return ref
    ? withWithdraw.readFrom([ref])
    : withWithdraw.attach.WithdrawalValidator(
        protocol.treasuryStakeValidators[family],
      );
};
