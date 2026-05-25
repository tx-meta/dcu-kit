
import {
    Data,
    LucidEvolution,
    validatorToAddress,
} from "@lucid-evolution/lucid";
import { Effect, Schedule } from "effect";
import { treasuryValidator, groupValidator, alwaysFailsValidator } from "../core/validators/constants.js";
import { DcuError, TransactionBuildError, SetupError } from "../core/errors.js";
import { getWalletAddress } from "../core/utils/index.js";

/**
 * Lovelace to lock per reference-script UTxO.
 *
 * Cardano's minimum UTxO rises with script size:
 *   treasury validator: ~8 KB → min ≈ 28 ADA
 *   group validator:    ~7 KB → min ≈ 24 ADA
 * These values add a comfortable buffer above the minimum.
 */
export const TREASURY_REF_LOVELACE = 30_000_000n; // 30 ADA
export const GROUP_REF_LOVELACE    = 26_000_000n; // 26 ADA

export type ScriptRefOutRef = { txHash: string; outputIndex: number };

export type DeployScriptsResult = {
    /** OutRef of the treasury validator reference UTxO. */
    treasuryRef: ScriptRefOutRef;
    /** OutRef of the group validator reference UTxO. */
    groupRef: ScriptRefOutRef;
    /** The alwaysFails script address both UTxOs were sent to. */
    deployAddress: string;
};

/**
 * Polls the wallet address until the given txHash appears in the UTxO set.
 *
 * Blockfrost's wallet UTxO endpoint can lag behind chain state even after
 * awaitTx returns. Once this poll succeeds, completeProgram() for the next tx
 * will also see fresh UTxOs because both hit the same Blockfrost endpoint.
 *
 * Retries every 3 seconds for up to 30 seconds before failing.
 */
const awaitWalletIndexed = (
    lucid: LucidEvolution,
    address: string,
    txHash: string,
): Effect.Effect<void, SetupError, never> =>
    Effect.retry(
        Effect.tryPromise({
            try: async () => {
                const utxos = await lucid.utxosAt(address);
                if (!utxos.some(u => u.txHash === txHash))
                    throw new Error("not indexed yet");
            },
            catch: () => new SetupError({
                message: `Timed out waiting for tx ${txHash.slice(0, 8)}... to appear in wallet UTxOs`,
            }),
        }),
        Schedule.spaced(3_000).pipe(Schedule.upTo(30_000)),
    );

/**
 * Deploys treasury and group validator reference scripts to a permanent
 * alwaysFails address, one per transaction.
 *
 * **Why alwaysFails?**
 * UTxOs at this address can never be spent — the validator always fails.
 * Reference scripts deposited here are permanently on-chain and safe to use
 * as `.readFrom()` inputs for the lifetime of the deployment.
 *
 * **Why two transactions?**
 * Each compiled PlutusV3 validator is ~8 KB. Both together plus the tx
 * envelope exceed Cardano's 16,384-byte limit. One per tx stays well under.
 *
 * **Why poll between transactions?**
 * Blockfrost's wallet UTxO endpoint can lag behind the chain even after
 * awaitTx returns. The poll ensures completeProgram() for Tx 2 sees the
 * fresh UTxO set (with Tx 1's change) so coin selection never picks a
 * spent input. Once the poll resolves, both the poll and completeProgram()
 * hit the same fresh Blockfrost state.
 *
 * **Cost**: ~56 ADA total (30 + 26) permanently locked. Cannot be reclaimed.
 *
 * @param lucid - Lucid instance with admin wallet selected (live network only).
 * @returns Effect yielding `DeployScriptsResult` with the two on-chain OutRefs.
 */
export const deployScripts = (
    lucid: LucidEvolution,
): Effect.Effect<DeployScriptsResult, DcuError, never> =>
    Effect.gen(function* () {
        const address = yield* getWalletAddress(lucid);
        const network = lucid.config().network!;
        const deployAddress = validatorToAddress(network, alwaysFailsValidator.elseAlwaysFails);

        // --- Tx 1: treasury validator ---
        const treasuryTxBuilder = yield* lucid
            .newTx()
            .pay.ToAddressWithData(
                deployAddress,
                { kind: "inline", value: Data.void() },
                { lovelace: TREASURY_REF_LOVELACE },
                { type: "PlutusV3", script: treasuryValidator.mintTreasury.script },
            )
            .addSigner(address)
            .completeProgram()
            .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "deployScripts:treasury:build", error: String(e) })));

        const treasurySigned = yield* Effect.tryPromise({
            try: () => treasuryTxBuilder.sign.withWallet().complete(),
            catch: e => new TransactionBuildError({ operation: "deployScripts:treasury:sign", error: String(e) }),
        });
        const treasuryTxHash = yield* Effect.tryPromise({
            try: () => treasurySigned.submit(),
            catch: e => new TransactionBuildError({ operation: "deployScripts:treasury:submit", error: String(e) }),
        });

        yield* Effect.tryPromise({
            try: () => lucid.awaitTx(treasuryTxHash),
            catch: e => new TransactionBuildError({ operation: "deployScripts:treasury:confirm", error: String(e) }),
        });

        // Poll until Blockfrost indexes Tx 1's change at the wallet address.
        // This guarantees completeProgram() for Tx 2 sees a fresh UTxO set.
        yield* awaitWalletIndexed(lucid, address, treasuryTxHash);

        // --- Tx 2: group validator ---
        const groupTxBuilder = yield* lucid
            .newTx()
            .pay.ToAddressWithData(
                deployAddress,
                { kind: "inline", value: Data.void() },
                { lovelace: GROUP_REF_LOVELACE },
                { type: "PlutusV3", script: groupValidator.spendGroup.script },
            )
            .addSigner(address)
            .completeProgram()
            .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "deployScripts:group:build", error: String(e) })));

        const groupSigned = yield* Effect.tryPromise({
            try: () => groupTxBuilder.sign.withWallet().complete(),
            catch: e => new TransactionBuildError({ operation: "deployScripts:group:sign", error: String(e) }),
        });
        const groupTxHash = yield* Effect.tryPromise({
            try: () => groupSigned.submit(),
            catch: e => new TransactionBuildError({ operation: "deployScripts:group:submit", error: String(e) }),
        });

        return {
            treasuryRef: { txHash: treasuryTxHash, outputIndex: 0 },
            groupRef:    { txHash: groupTxHash,    outputIndex: 0 },
            deployAddress,
        };
    });
