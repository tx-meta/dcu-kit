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
  /** The published trusted policies, if the settings UTxO was found and parsed. */
  settings?: {
    account_policy: string;
    group_policy: string;
    treasury_policy: string;
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
      parsed.account_policy === expected.accountPolicyId;

    return {
      found: true,
      settingsUnit,
      settingsAddress,
      settings: {
        account_policy: parsed.account_policy,
        group_policy: parsed.group_policy,
        treasury_policy: parsed.treasury_policy,
      },
      consistent,
    };
  });

export const verifySettings = (lucid: LucidEvolution, settingsPolicy: string) =>
  Effect.runPromise(unsignedVerifySettingsProgram(lucid, settingsPolicy));
