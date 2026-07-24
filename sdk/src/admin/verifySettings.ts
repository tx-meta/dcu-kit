import {
  Data,
  LucidEvolution,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  buildProtocol,
  settingsTokenName,
  alwaysFailsValidator,
} from "../core/validators/constants.js";
import { ProtocolSettings, ProtocolSettingsSchema } from "../core/types.js";
import { DcuError, SetupError } from "../core/errors.js";

export type VerifySettingsResult = {
  found: boolean;
  settingsUnit: string;
  settingsAddress: string;
  /** The address the settings UTxO actually sits at, when found. */
  utxoAddress?: string;
  /** The published trusted policies, if the settings UTxO was found and parsed. */
  settings?: {
    account_policy: string;
    group_policy: string;
    treasury_policy: string;
    treasury_rounds_stake: string;
    treasury_lifecycle_stake: string;
    treasury_recovery_stake: string;
    treasury_reserve_stake: string;
  };
  /** True if the published treasury/group policies match buildProtocol(settingsPolicy). */
  consistent?: boolean;
};

/**
 * Verify the protocol settings UTxO for a deployment: it exists at the always-fails
 * address, holds the singleton settings NFT, and its ProtocolSettings datum's policy IDs
 * match those derived from the settings policy. Idempotent — safe to re-run.
 */
export const unsignedVerifySettingsProgram = (
  lucid: LucidEvolution,
  settingsPolicy: string,
): Effect.Effect<VerifySettingsResult, DcuError, never> =>
  Effect.gen(function* () {
    const network = lucid.config().network!;
    const settingsUnit = settingsPolicy + settingsTokenName;
    const settingsAddress = validatorToAddress(
      network,
      alwaysFailsValidator.elseAlwaysFails,
    );

    const utxo = yield* Effect.tryPromise({
      try: () => lucid.utxoByUnit(settingsUnit),
      catch: () =>
        new SetupError({ message: "settings NFT not found on-chain" }),
    }).pipe(Effect.orElse(() => Effect.succeed(undefined)));

    if (!utxo || !utxo.datum)
      return { found: false, settingsUnit, settingsAddress };

    const parsed = Data.from(
      utxo.datum,
      ProtocolSettings,
    ) as unknown as Data.Static<typeof ProtocolSettingsSchema>;
    const expected = buildProtocol(settingsPolicy);
    const consistent =
      parsed.treasury_policy === expected.treasuryPolicyId &&
      parsed.group_policy === expected.groupPolicyId &&
      parsed.account_policy === expected.accountPolicyId &&
      parsed.treasury_rounds_stake === expected.treasuryStakeHashes.rounds &&
      parsed.treasury_lifecycle_stake ===
        expected.treasuryStakeHashes.lifecycle &&
      parsed.treasury_recovery_stake ===
        expected.treasuryStakeHashes.recovery &&
      parsed.treasury_reserve_stake === expected.treasuryStakeHashes.reserve;

    return {
      found: true,
      settingsUnit,
      settingsAddress,
      utxoAddress: utxo.address,
      settings: {
        account_policy: parsed.account_policy,
        group_policy: parsed.group_policy,
        treasury_policy: parsed.treasury_policy,
        treasury_rounds_stake: parsed.treasury_rounds_stake,
        treasury_lifecycle_stake: parsed.treasury_lifecycle_stake,
        treasury_recovery_stake: parsed.treasury_recovery_stake,
        treasury_reserve_stake: parsed.treasury_reserve_stake,
      },
      consistent,
    };
  });

export const verifySettings = (lucid: LucidEvolution, settingsPolicy: string) =>
  Effect.runPromise(unsignedVerifySettingsProgram(lucid, settingsPolicy));
