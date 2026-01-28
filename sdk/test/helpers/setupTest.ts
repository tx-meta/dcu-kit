import { Network, UTxO, validatorToAddress, fromText } from "@lucid-evolution/lucid";
import { LucidContext, makeLucidContext } from "../infra/lucidContext.js";
import { Effect } from "effect";
import { AccountDatum } from "../../src/core/account.types.js";
import { DcuValidators, makeValidators } from "../../src/core/validators/context.js";
import { findUtxoWithToken } from "../../src/core/utils.js";
import { createAccountTestCase } from "../account/actions.js";

export type BaseSetup = {
  network: Network;
  context: LucidContext;
  scripts: DcuValidators;
};

export type SetupResult = {
  context: LucidContext;
  scripts: DcuValidators;
  accountUtxo?: UTxO;
  userUtxo?: UTxO;
};

export const setupBase = (): Effect.Effect<BaseSetup, Error, never> => {
    return Effect.gen(function* (_) {
        const { lucid, users, emulator } = yield* makeLucidContext();
        const network = lucid.config().network;
        if (!network) throw Error("Invalid Network selection");

        const scripts = yield* makeValidators(network);

        return {
            network,
            context: { lucid, users, emulator },
            scripts
        };
    });
};

export const setupAccount = (
    base: BaseSetup,
    datumOverride?: Partial<AccountDatum>
): Effect.Effect<SetupResult, Error, never> =>
    Effect.gen(function* (_) {
        const { lucid, users, emulator } = base.context;
        const { scripts } = base;
        
        // Use TestCase to create the account, passing injected scripts
        yield* createAccountTestCase({ lucid, users, emulator }, scripts, datumOverride);

        if (emulator && base.network === "Custom") {
             yield* Effect.sync(() => emulator.awaitBlock(5));
        }

        const accountAddress = scripts.account.spend.address;
        const accountUtxos = yield* Effect.promise(() => lucid.utxosAt(accountAddress));
        
        const accountPolicyId = scripts.account.mint.policyId;
        
        const accountReferenceToken = accountPolicyId + fromText("AccountReference");
        const accountUtxo = findUtxoWithToken(accountUtxos, accountPolicyId, fromText("AccountReference"));
        if (!accountUtxo) throw new Error("Account UTxO not found after creation");

        lucid.selectWallet.fromSeed(users.user1.seedPhrase);
        const walletUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
        
        const userTokenName = fromText("AccountUser");
        const currentUserUtxo = findUtxoWithToken(walletUtxos, accountPolicyId, userTokenName);
        if (!currentUserUtxo) throw new Error("User Auth Token UTxO not found");

        return {
            context: base.context,
            scripts,
            accountUtxo,
            userUtxo: currentUserUtxo
        };
    });
