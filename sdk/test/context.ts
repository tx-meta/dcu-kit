import {
  Blockfrost,
  Data,
  Emulator,
  generateEmulatorAccount,
  Kupmios,
  Lucid,
  LucidEvolution,
  Maestro,
  Network,
  PROTOCOL_PARAMETERS_DEFAULT,
  validatorToAddress,
  validatorToRewardAddress,
} from "@lucid-evolution/lucid";
import { ConfigurationError } from "../src/core/errors.js";
import { Effect } from "effect";
import {
  alwaysFailsValidator,
  buildProtocol,
  buildSettingsNft,
  Protocol,
  settingsTokenName,
} from "../src/core/validators/constants.js";
import { ProtocolSettings } from "../src/core/types.js";

export type OnChainNetwork = Extract<
  Network,
  "Mainnet" | "Preprod" | "Preview"
>;

// --- Types ---

export type TestUser = {
  seedPhrase: string;
  address?: string;
};

export type LucidContext = {
  lucid: LucidEvolution;
  users: {
    admin: TestUser;
    user1: TestUser;
    user2: TestUser;
  };
  emulator?: Emulator;
  // The deployment's protocol context (validators/policies derived from the settings
  // policy). Deployed once in the emulator setup; required by all group/treasury ops.
  // Optional only because live-network contexts derive it from a pre-deployed settings
  // policy (env) rather than minting one; the emulator path always sets it.
  protocol?: Protocol;
  settingsUnit?: string;
};

export type Provider = "Emulator" | "Maestro" | "Blockfrost" | "Kupmios";

export type ContextConfig = {
  network: Network;
  provider: Provider;
};

// --- Config Loading ---

const loadConfigFromEnv = (): ContextConfig => {
  const networkRaw = process.env.NETWORK;

  // "Emulator" is not a valid Lucid Network — normalise to "Custom".
  // When the network is local/emulated, ignore PROVIDER and API keys entirely.
  if (!networkRaw || networkRaw === "Emulator" || networkRaw === "Custom") {
    return { network: "Custom", provider: "Emulator" };
  }

  // Live network path — NETWORK must be Preprod | Preview | Mainnet
  const network = networkRaw as Network;
  const providerEnv = process.env.PROVIDER as Provider | undefined;

  let provider: Provider;
  if (providerEnv && providerEnv !== "Emulator") {
    provider = providerEnv;
  } else if (process.env.BLOCKFROST_KEY && process.env.BLOCKFROST_URL) {
    provider = "Blockfrost";
  } else if (process.env.MAESTRO_API_KEY) {
    provider = "Maestro";
  } else if (process.env.OGMIOS_URL && process.env.KUPO_URL) {
    provider = "Kupmios";
  } else {
    throw new Error(
      `NETWORK=${network} requires a provider. Set PROVIDER= or supply BLOCKFROST_KEY / MAESTRO_API_KEY / OGMIOS_URL+KUPO_URL.`,
    );
  }

  return { network, provider };
};

// --- Providers ---

// Deploy the protocol settings once for an emulator run: mint the singleton settings
// NFT (seeded by an admin UTxO) and lock it + the ProtocolSettings datum at the
// always-fails address. Returns the deployment's protocol context.
const deployEmulatorSettings = (
  lucid: LucidEvolution,
  emulator: Emulator,
  adminSeed: string,
) =>
  Effect.gen(function* () {
    lucid.selectWallet.fromSeed(adminSeed);
    const utxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
    const seed = utxos[0];
    const { validator, policyId: settingsPolicy } = buildSettingsNft({
      txHash: seed.txHash,
      outputIndex: seed.outputIndex,
    });
    const protocol = buildProtocol(settingsPolicy);
    const settingsUnit = settingsPolicy + settingsTokenName;
    const settingsAddress = validatorToAddress(
      "Custom",
      alwaysFailsValidator.elseAlwaysFails,
    );
    const datum = Data.to(
      {
        account_policy: protocol.accountPolicyId,
        group_policy: protocol.groupPolicyId,
        treasury_policy: protocol.treasuryPolicyId,
      },
      ProtocolSettings,
    );
    const tx = yield* Effect.promise(() =>
      lucid
        .newTx()
        .collectFrom([seed])
        .mintAssets({ [settingsUnit]: 1n }, Data.void())
        .attach.MintingPolicy(validator)
        .pay.ToContract(
          settingsAddress,
          { kind: "inline", value: datum },
          { [settingsUnit]: 1n },
        )
        .complete(),
    );
    const signed = yield* Effect.promise(() => tx.sign.withWallet().complete());
    yield* Effect.promise(() => signed.submit());
    emulator.awaitBlock(1);

    // Withdraw-zero prerequisite: register the treasury's own stake credential so that
    // distribute / next-cycle txs can carry the 0-ADA reward withdrawal that triggers the
    // treasury `withdraw` handler. The emulator's submit enforces that a withdrawal matches
    // the registered reward balance, so an unregistered credential rejects even a 0 withdrawal.
    // (Production: deploy-scripts must perform this same one-time registration on Preprod/mainnet.)
    const treasuryRewardAddress = validatorToRewardAddress(
      "Custom",
      protocol.treasuryValidator.spendTreasury,
    );
    const regTx = yield* Effect.promise(() =>
      lucid.newTx().register.Stake(treasuryRewardAddress).complete(),
    );
    const regSigned = yield* Effect.promise(() =>
      regTx.sign.withWallet().complete(),
    );
    yield* Effect.promise(() => regSigned.submit());
    emulator.awaitBlock(1);

    return { protocol, settingsUnit };
  });

const makeEmulatorContext = (seedAssets?: Record<string, bigint>) =>
  Effect.gen(function* () {
    const generate = () =>
      generateEmulatorAccount({
        lovelace: BigInt(1_000_000_000),
        ...(seedAssets ?? {}),
      });

    const admin = yield* Effect.sync(generate);
    const user1 = yield* Effect.sync(generate);
    const user2 = yield* Effect.sync(generate);

    const emulator = new Emulator([admin, user1, user2], {
      ...PROTOCOL_PARAMETERS_DEFAULT,
      // Test-only allowance. These emulator tests INLINE the ~15 KB validator in every
      // tx for simplicity; production uses reference scripts (deploy-scripts /
      // distributePayout.scriptRefs), which keep real txs well under Cardano's 16,384-byte
      // limit. This number only needs to fit the inline-script test txs, not mainnet.
      // TODO: switch join/nextCycle/contribute tests to reference scripts and drop this.
      maxTxSize: 26000,
    });

    const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));

    // Deploy protocol settings once before any group/treasury operation.
    const { protocol, settingsUnit } = yield* deployEmulatorSettings(
      lucid,
      emulator,
      admin.seedPhrase,
    );

    return {
      lucid,
      users: {
        admin: { seedPhrase: admin.seedPhrase, address: admin.address },
        user1: { seedPhrase: user1.seedPhrase, address: user1.address },
        user2: { seedPhrase: user2.seedPhrase, address: user2.address },
      },
      emulator,
      protocol,
      settingsUnit,
    } as LucidContext;
  });

// Benchmark helper: an emulator context with `memberCount` funded member wallets
// (plus admin), exposed as `memberSeeds`. Used by the scale benchmark to build
// N-member distribute rounds. maxTxSize defaults very high so transaction SIZE never
// blocks the build — the benchmark measures EX-UNITS (mem/cpu), which are independent
// of inline-vs-reference scripts and are the real per-tx constraint.
export const makeEmulatorContextWithMembers = (
  memberCount: number,
  options?: { seedAssets?: Record<string, bigint>; maxTxSize?: number },
) =>
  Effect.gen(function* () {
    const generate = () =>
      generateEmulatorAccount({
        lovelace: BigInt(10_000_000_000),
        ...(options?.seedAssets ?? {}),
      });

    const admin = yield* Effect.sync(generate);
    const members = yield* Effect.sync(() =>
      Array.from({ length: memberCount }, generate),
    );

    const emulator = new Emulator([admin, ...members], {
      ...PROTOCOL_PARAMETERS_DEFAULT,
      maxTxSize: options?.maxTxSize ?? 5_000_000,
    });

    const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));

    const { protocol, settingsUnit } = yield* deployEmulatorSettings(
      lucid,
      emulator,
      admin.seedPhrase,
    );

    return {
      lucid,
      users: {
        admin: { seedPhrase: admin.seedPhrase, address: admin.address },
        user1: {
          seedPhrase: members[0]?.seedPhrase ?? admin.seedPhrase,
          address: members[0]?.address,
        },
        user2: {
          seedPhrase: members[1]?.seedPhrase ?? admin.seedPhrase,
          address: members[1]?.address,
        },
      },
      emulator,
      protocol,
      settingsUnit,
      memberSeeds: members.map((m) => m.seedPhrase),
    } as LucidContext & { memberSeeds: string[] };
  });

const makeMaestroContext = (network: OnChainNetwork) =>
  Effect.gen(function* () {
    const apiKey = process.env.MAESTRO_API_KEY;
    if (!apiKey)
      return yield* Effect.die(
        new ConfigurationError({
          configKey: "MAESTRO_API_KEY",
          message: "Missing MAESTRO_API_KEY",
        }),
      );

    const maestro = new Maestro({
      network: network,
      apiKey,
      turboSubmit: false,
    });

    const lucid = yield* Effect.promise(() => Lucid(maestro, network));

    return {
      lucid,
      users: loadUsersFromEnv(),
      emulator: undefined,
    } as LucidContext;
  });

const makeBlockfrostContext = (network: OnChainNetwork) =>
  Effect.gen(function* () {
    const projectId = process.env.BLOCKFROST_KEY;
    const url = process.env.BLOCKFROST_URL;

    if (!projectId || !url) {
      return yield* Effect.die(
        new ConfigurationError({
          configKey: "BLOCKFROST_KEY",
          message: "Missing BLOCKFROST_KEY or BLOCKFROST_URL",
        }),
      );
    }

    const blockfrost = new Blockfrost(url, projectId);
    const lucid = yield* Effect.promise(() => Lucid(blockfrost, network));

    return {
      lucid,
      users: loadUsersFromEnv(),
      emulator: undefined,
    } as LucidContext;
  });

const makeKupmiosContext = (network: OnChainNetwork) =>
  Effect.gen(function* () {
    const kupoUrl = process.env.KUPO_URL;
    const ogmiosUrl = process.env.OGMIOS_URL;

    if (!kupoUrl || !ogmiosUrl) {
      return yield* Effect.die(
        new ConfigurationError({
          configKey: "KUPO/OGMIOS_URL",
          message: "Missing KUPO_URL or OGMIOS_URL",
        }),
      );
    }

    const kupmios = new Kupmios(kupoUrl, ogmiosUrl);
    const lucid = yield* Effect.promise(() => Lucid(kupmios, network));

    return {
      lucid,
      users: loadUsersFromEnv(),
      emulator: undefined,
    } as LucidContext;
  });

const loadUsersFromEnv = () => {
  const adminSeed = process.env.ADMIN_SEED;
  const user1Seed = process.env.USER1_SEED;
  const user2Seed = process.env.USER2_SEED;

  if (!adminSeed || !user1Seed || !user2Seed) {
    // Throw a native Error — this runs outside an Effect generator so Effect.fail
    // is not available. The missing env var is a CI configuration bug, not a
    // recoverable runtime condition.
    const missing = [
      !adminSeed && "ADMIN_SEED",
      !user1Seed && "USER1_SEED",
      !user2Seed && "USER2_SEED",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Live network testing requires seed phrases for all three wallets. Missing: ${missing}.`,
    );
  }

  return {
    admin: { seedPhrase: adminSeed },
    user1: { seedPhrase: user1Seed },
    user2: { seedPhrase: user2Seed },
  };
};

const ensureOnChain = (network: Network, provider: string) =>
  network === "Custom"
    ? Effect.die(
        new ConfigurationError({
          configKey: `${provider.toUpperCase()}_NETWORK`,
          message: `${provider} provider does not support 'Custom' network`,
        }),
      )
    : Effect.succeed(network as OnChainNetwork);

// --- Entry Point ---

export const makeLucidContext = (
  overrideConfig?: Partial<ContextConfig>,
  seedAssets?: Record<string, bigint>,
) =>
  Effect.gen(function* () {
    const envConfig = loadConfigFromEnv();
    const config = { ...envConfig, ...overrideConfig };

    if (config.provider === "Emulator") {
      console.log("Context: Emulator (local)");
    } else {
      console.log(`Context: ${config.provider} on ${config.network}`);
    }

    switch (config.provider) {
      case "Blockfrost":
        return yield* makeBlockfrostContext(
          yield* ensureOnChain(config.network, "Blockfrost"),
        );
      case "Maestro":
        return yield* makeMaestroContext(
          yield* ensureOnChain(config.network, "Maestro"),
        );
      case "Kupmios":
        return yield* makeKupmiosContext(
          yield* ensureOnChain(config.network, "Kupmios"),
        );
      case "Emulator":
      default:
        return yield* makeEmulatorContext(seedAssets);
    }
  });

// Re-export specific helpers if needed, but makeLucidContext is the main one.
export { Network };
