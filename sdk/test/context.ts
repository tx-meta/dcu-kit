import {
  Blockfrost,
  Emulator,
  generateEmulatorAccount,
  Kupmios,
  Lucid,
  LucidEvolution,
  Maestro,
  Network,
  PROTOCOL_PARAMETERS_DEFAULT,
} from "@lucid-evolution/lucid";
import { ConfigurationError } from "../src/core/errors.js";
import { Effect } from "effect";

export type OnChainNetwork = Extract<Network, "Mainnet" | "Preprod" | "Preview">;

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
};

export type Provider = "Emulator" | "Maestro" | "Blockfrost" | "Kupmios";

export type ContextConfig = {
  network: Network;
  provider: Provider;
};

const DEFAULT_CONFIG: ContextConfig = {
  network: "Preprod",
  provider: "Emulator",
};

// --- Config Loading ---

const loadConfigFromEnv = (): ContextConfig => {
  const network = (process.env.NETWORK as Network) || "Preprod";
  const providerEnv = process.env.PROVIDER as Provider | undefined;

  let provider: Provider = "Emulator";

  if (providerEnv) {
    provider = providerEnv;
  } else if (process.env.BLOCKFROST_KEY) {
    provider = "Blockfrost";
  } else if (process.env.MAESTRO_API_KEY) {
    provider = "Maestro";
  } else if (process.env.OGMIOS_URL && process.env.KUPO_URL) {
    provider = "Kupmios";
  }

  return { network, provider };
};

// --- Providers ---

const makeEmulatorContext = () =>
  Effect.gen(function* () {
    const generate = () =>
      generateEmulatorAccount({ lovelace: BigInt(1_000_000_000) });

    const admin = yield* Effect.sync(generate);
    const user1 = yield* Effect.sync(generate);
    const user2 = yield* Effect.sync(generate);

    const emulator = new Emulator([admin, user1, user2], {
      ...PROTOCOL_PARAMETERS_DEFAULT,
      maxTxSize: 23000,
    });

    const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));

    return {
      lucid,
      users: {
        admin: { seedPhrase: admin.seedPhrase, address: admin.address },
        user1: { seedPhrase: user1.seedPhrase, address: user1.address },
        user2: { seedPhrase: user2.seedPhrase, address: user2.address },
      },
      emulator,
    } as LucidContext;
  });

const makeMaestroContext = (network: OnChainNetwork) =>
  Effect.gen(function* () {
    const apiKey = process.env.MAESTRO_API_KEY;
    if (!apiKey) return yield* Effect.die(new ConfigurationError({ configKey: "MAESTRO_API_KEY", message: "Missing MAESTRO_API_KEY" }));

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
      return yield* Effect.die(new ConfigurationError({ configKey: "BLOCKFROST_KEY", message: "Missing BLOCKFROST_KEY or BLOCKFROST_URL" }));
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
        return yield* Effect.die(new ConfigurationError({ configKey: "KUPO/OGMIOS_URL", message: "Missing KUPO_URL or OGMIOS_URL" }));
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
  // user2 might be optional or generated
  const user2Seed = process.env.USER2_SEED || user1Seed;

  if (!adminSeed || !user1Seed) {
    throw new ConfigurationError({
        configKey: "ADMIN_SEED/USER1_SEED",
        message: "Missing ADMIN_SEED or USER1_SEED for live network testing."
    });
  }

  return {
    admin: { seedPhrase: adminSeed },
    user1: { seedPhrase: user1Seed },
    user2: { seedPhrase: user2Seed! },
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

export const makeLucidContext = (overrideConfig?: Partial<ContextConfig>) =>
  Effect.gen(function* ($) {
    const envConfig = loadConfigFromEnv();
    const config = { ...envConfig, ...overrideConfig };

    if (config.provider === "Emulator") {
      console.log("Context: Emulator");
    } else {
      console.log(`Context: ${config.provider} on ${config.network}`);
    }

    switch (config.provider) {
      case "Blockfrost":
        return yield* $(
          makeBlockfrostContext(yield* ensureOnChain(config.network, "Blockfrost")),
        );
      case "Maestro":
        return yield* $(
          makeMaestroContext(yield* ensureOnChain(config.network, "Maestro")),
        );
      case "Kupmios":
        return yield* $(
          makeKupmiosContext(yield* ensureOnChain(config.network, "Kupmios")),
        );
      case "Emulator":
      default:
        return yield* $(makeEmulatorContext());
    }
  });

// Re-export specific helpers if needed, but makeLucidContext is the main one.
export { Network };
