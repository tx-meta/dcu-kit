import {
  Network,
  Redeemer,
  RedeemerBuilder,
  TxBuilder,
  UTxO,
} from "@lucid-evolution/lucid";
import {
  SavingsFamily,
  savingsFamilyRewardAddress,
  savingsFamilyValidator,
} from "./validators.js";

// familyWithdraw — the offchain half of the savings split (ADR-0003).
// ─────────────────────────────────────────────────────────────────────────────
// The vault dispatcher delegates all heavy validation to two withdraw-zero
// family stake validators (governed / direct). Every savings endpoint therefore:
//   1. spends with a slim SavingsSpendRedeemer — a bare literal for the direct
//      six, `{ Op: { intent_hash } }` for the governed six,
//   2. carries a single 0-ADA withdrawal from the family's stake credential
//      whose action redeemer holds `covered_inputs` (the coverage invariant)
//      plus every index the operation needs, and
//   3. attaches the family stake validator inline unless its reference script is
//      supplied.
//
// The reward address the withdrawal targets identifies the family on-chain: the
// vault is compiled with both family hashes as parameters, so a lookalike
// credential is simply not the one it looks up.

/**
 * Adds the 0-ADA family withdrawal that runs the family action once per
 * transaction, and attaches the family stake validator inline unless its
 * reference script is supplied. Returns the extended transaction builder.
 *
 * On live networks the reference script is required: the family validators are
 * roughly 8.8 KB each, so attaching one inline alongside the vault reference
 * pushes composite transactions past the 16,384-byte limit. The inline fallback
 * is emulator-only (`Custom`).
 *
 * @param action - the family action; a {@link RedeemerBuilder} whenever its
 *   `covered_inputs` and index fields depend on resolved input positions, which
 *   is every case except a fully static one.
 */
export const attachSavingsFamilyWithdrawal = (
  tx: TxBuilder,
  network: Network,
  family: SavingsFamily,
  action: RedeemerBuilder | Redeemer,
  familyRef?: UTxO,
): TxBuilder => {
  const withWithdraw = tx.withdraw(
    savingsFamilyRewardAddress(network, family),
    0n,
    action,
  );
  if (!familyRef && network !== "Custom")
    throw new Error(
      `Missing reference script for the savings ${family} family on ${network}. ` +
        `Pass familyRef from deployModuleScripts/loadScriptRefs — attaching the ` +
        `family validator inline exceeds the transaction size limit.`,
    );
  return familyRef
    ? withWithdraw.readFrom([familyRef])
    : withWithdraw.attach.WithdrawalValidator(savingsFamilyValidator[family]);
};

/** Shared config fields every savings endpoint that spends a vault UTxO takes. */
export type SavingsRefConfig = {
  /** Deployed savings vault dispatcher reference — pass on live networks. */
  scriptRef?: UTxO;
  /**
   * Deployed reference script for the family this operation belongs to
   * (`savings_governed` or `savings_direct`). Required on live networks.
   */
  familyRef?: UTxO;
};
