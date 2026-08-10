import { LucidEvolution } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError } from "../core/errors.js";
import {
  registerStakeCredentials,
  StakeRegistration,
} from "../admin/registerTreasuryStake.js";
import { SavingsFamily, savingsFamilyRewardAddress } from "./validators.js";

const FAMILIES: SavingsFamily[] = ["governed", "direct"];

export type RegisterSavingsStakeResult = {
  /** One outcome per savings family (governed / direct). */
  registrations: StakeRegistration[];
  /** true when BOTH credentials were already registered (a full re-run). */
  alreadyRegistered: boolean;
};

/**
 * Registers the two savings family stake credentials (governed / direct).
 *
 * Since ADR-0003 every savings operation carries a 0-ADA reward withdrawal from
 * its family's stake validator — the once-per-transaction home of the heavy
 * validation. The ledger rejects a withdrawal from an unregistered stake
 * credential, so this must run once per deployment before ANY savings endpoint
 * is used, alongside the four treasury registrations.
 *
 * Re-running is safe: a duplicate-registration rejection is treated as success,
 * and a rejected transaction never enters a block.
 *
 * @param lucid - Lucid instance with a funded wallet selected (pays the key
 *                deposit per credential not yet registered).
 */
export const registerSavingsStake = (
  lucid: LucidEvolution,
): Effect.Effect<RegisterSavingsStakeResult, DcuError, never> =>
  Effect.gen(function* () {
    const network = lucid.config().network!;
    const registrations = yield* registerStakeCredentials(
      lucid,
      FAMILIES.map((family) => ({
        label: family,
        rewardAddress: savingsFamilyRewardAddress(network, family),
      })),
      "registerSavingsStake",
    );
    return {
      registrations,
      alreadyRegistered: registrations.every((r) => r.alreadyRegistered),
    };
  });
