import {
    Emulator,
    generateEmulatorAccount,
    Lucid,
    LucidEvolution,
    Maestro,
    PROTOCOL_PARAMETERS_DEFAULT,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";

export type LucidContext = {
    lucid: LucidEvolution;
    users: any;
    emulator?: Emulator;
};

export type Network = "Mainnet" | "Preprod" | "Preview" | "Custom";

export const NETWORK = (process.env.NETWORK as Network) || "Preprod";

export const makeEmulatorContext = () =>
    Effect.gen(function* (_) {
        const users = {
            admin: yield* Effect.sync(() =>
                generateEmulatorAccount({ lovelace: BigInt(1_000_000_000) })
            ),
            user1: yield* Effect.sync(() =>
                generateEmulatorAccount({ lovelace: BigInt(1_000_000_000) })
            ),
            user2: yield* Effect.sync(() =>
                generateEmulatorAccount({ lovelace: BigInt(1_000_000_000) })
            ),
        };

        const emulator = new Emulator(
            [users.admin, users.user1, users.user2],
            {
                ...PROTOCOL_PARAMETERS_DEFAULT,
                maxTxSize: 23000,
            },
        );

        const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));

        return { lucid, users, emulator } as LucidContext;
    });

export const makeMaestroContext = (network: Network) =>
    Effect.gen(function* (_) {
        const API_KEY = process.env.API_KEY!;
        const ADMIN_SEED = process.env.ADMIN_SEED!;
        const USER1_SEED = process.env.USER1_SEED!;

        if (!API_KEY) {
            throw new Error(
                "Missing required environment variables for Maestro context.",
            );
        }

        if (network === "Custom") {
            throw new Error(
                "Cannot create Maestro context with 'Custom' network.",
            );
        }

        const users = {
            admin: {
                seedPhrase: ADMIN_SEED,
            },
            user1: {
                seedPhrase: USER1_SEED,
            },
        };

        const maestro = new Maestro({
            network: network,
            apiKey: API_KEY,
            turboSubmit: false,
        });

        const lucid = yield* Effect.promise(() => Lucid(maestro, network));

        return { lucid, users, emulator: undefined } as LucidContext;
    });

export const makeLucidContext = (network?: Network) =>
    Effect.gen(function* ($) {
        const API_KEY = process.env.API_KEY;

        const selectedNetwork = network ?? NETWORK;
        
        if (API_KEY && selectedNetwork && selectedNetwork !== "Custom") {
            // Use Maestro context
            console.log("selectedNetwork", selectedNetwork);
            return yield* $(makeMaestroContext(selectedNetwork));
        } else {
            // Use Emulator context
            console.log("selectedNetwork: Emulator");
            return yield* $(makeEmulatorContext());
        }
    });
