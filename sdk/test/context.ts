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
import { Effect } from "effect";

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

const makeMaestroContext = (network: Network) =>
  Effect.gen(function* () {
    const apiKey = process.env.MAESTRO_API_KEY;
    if (!apiKey) throw new Error("Missing MAESTRO_API_KEY");

    if (network === "Custom") {
      throw new Error("Maestro provider does not support 'Custom' network");
    }

    const maestro = new Maestro({
      network: network as "Mainnet" | "Preprod" | "Preview",
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

const makeBlockfrostContext = (network: Network) =>
  Effect.gen(function* () {
    const projectId = process.env.BLOCKFROST_KEY;
    const url = process.env.BLOCKFROST_URL;

    if (!projectId || !url) {
      throw new Error("Missing BLOCKFROST_KEY or BLOCKFROST_URL in environment variables");
    }

    const blockfrost = new Blockfrost(url, projectId);
    const lucid = yield* Effect.promise(() => Lucid(blockfrost, network));

    return {
      lucid,
      users: loadUsersFromEnv(),
      emulator: undefined,
    } as LucidContext;
  });

const makeKupmiosContext = (network: Network) =>
  Effect.gen(function* () {
    const kupoUrl = process.env.KUPO_URL;
    const ogmiosUrl = process.env.OGMIOS_URL;

    if (!kupoUrl || !ogmiosUrl) {
        throw new Error("Missing KUPO_URL or OGMIOS_URL for Kupmios provider");
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
  const user2Seed = process.env.USER2_SEED || user1Seed; // Fallback or throw

  if (!adminSeed || !user1Seed) {
    throw new Error(
      "Missing ADMIN_SEED or USER1_SEED for live network testing."
    );
  }

  return {
    admin: { seedPhrase: adminSeed },
    user1: { seedPhrase: user1Seed },
    user2: { seedPhrase: user2Seed! },
  };
};

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
        return yield* $(makeBlockfrostContext(config.network));
      case "Maestro":
        return yield* $(makeMaestroContext(config.network));
      case "Kupmios":
        return yield* $(makeKupmiosContext(config.network));
      case "Emulator":
      default:
        return yield* $(makeEmulatorContext());
    }
  });

// Re-export specific helpers if needed, but makeLucidContext is the main one.
export { Network };
