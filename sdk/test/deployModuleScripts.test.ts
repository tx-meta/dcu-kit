import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  validatorToAddress,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { setupBase } from "./setup.js";
import { advanceBlock } from "./effects.js";
import { deployModuleScripts } from "../src/admin/deployModuleScripts.js";
import { MAX_REF_SCRIPT_BYTES } from "../src/admin/refScripts.js";
import { alwaysFailsValidator } from "../src/core/validators/constants.js";
import { savingsVaultValidator } from "../src/savings/validators.js";
import { escrowV2Validator } from "../src/escrow/v2/validators.js";
import { selectWalletFromSeed } from "../src/core/utils/index.js";

// The emulator never advances on its own, so the default provider poll would
// spin until it times out. Tests hand the deploy a block-advancing wait.
const emulatorSettle = (emulator: Parameters<typeof advanceBlock>[0]) => () =>
  advanceBlock(emulator);

describe("deployModuleScripts (emulator)", () => {
  it.effect("publishes module refs at the always-fails address", () =>
    Effect.gen(function* () {
      const { context, network } = yield* setupBase();
      const { lucid, emulator } = context;
      selectWalletFromSeed(lucid, context.users.admin.seedPhrase);

      const result = yield* deployModuleScripts(
        {
          savings: savingsVaultValidator.spendVault,
          escrowV2: escrowV2Validator.spendEscrow,
        },
        lucid,
        { awaitSettled: emulatorSettle(emulator) },
      );

      const alwaysFailsAddress = validatorToAddress(
        network,
        alwaysFailsValidator.elseAlwaysFails,
      );
      expect(result.deployAddress).toBe(alwaysFailsAddress);
      expect(result.status).toEqual({
        savings: "deployed",
        escrowV2: "deployed",
      });

      // Both refs must be resolvable, carry the script, and sit where they can
      // never be spent — the property the whole function exists for.
      const utxos = yield* Effect.promise(() =>
        lucid.utxosByOutRef([result.refs.savings!, result.refs.escrowV2!]),
      );
      expect(utxos).toHaveLength(2);
      for (const utxo of utxos) {
        expect(utxo.address).toBe(alwaysFailsAddress);
        expect(utxo.scriptRef).toBeTruthy();
      }
      const hashes = utxos.map((u) => validatorToScriptHash(u.scriptRef!));
      expect(hashes).toContain(
        validatorToScriptHash(savingsVaultValidator.spendVault),
      );
      expect(hashes).toContain(
        validatorToScriptHash(escrowV2Validator.spendEscrow),
      );
    }),
  );

  it.effect("reuses a recorded ref that still carries the same script", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const { lucid, emulator } = context;
      selectWalletFromSeed(lucid, context.users.admin.seedPhrase);

      const first = yield* deployModuleScripts(
        { savings: savingsVaultValidator.spendVault },
        lucid,
        { awaitSettled: emulatorSettle(emulator) },
      );

      const second = yield* deployModuleScripts(
        { savings: savingsVaultValidator.spendVault },
        lucid,
        {
          existing: { savings: first.refs.savings },
          awaitSettled: emulatorSettle(emulator),
        },
      );

      expect(second.status.savings).toBe("reused");
      expect(second.refs.savings).toEqual(first.refs.savings);
    }),
  );

  it.effect("publishes a new ref on upgrade and leaves the old one alive", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const { lucid, emulator } = context;
      selectWalletFromSeed(lucid, context.users.admin.seedPhrase);

      // A recorded ref carrying a DIFFERENT script stands in for an upgraded
      // validator: the new script must be published without touching the old.
      const old = yield* deployModuleScripts(
        { escrowV2: escrowV2Validator.spendEscrow },
        lucid,
        { awaitSettled: emulatorSettle(emulator) },
      );

      const upgraded = yield* deployModuleScripts(
        { escrowV2: savingsVaultValidator.spendVault },
        lucid,
        {
          existing: { escrowV2: old.refs.escrowV2 },
          awaitSettled: emulatorSettle(emulator),
        },
      );

      expect(upgraded.status.escrowV2).toBe("deployed");
      expect(upgraded.refs.escrowV2).not.toEqual(old.refs.escrowV2);

      // The superseded reference is still on-chain and still usable.
      const [oldUtxo] = yield* Effect.promise(() =>
        lucid.utxosByOutRef([old.refs.escrowV2!]),
      );
      expect(oldUtxo?.scriptRef).toBeTruthy();
      expect(validatorToScriptHash(oldUtxo.scriptRef!)).toBe(
        validatorToScriptHash(escrowV2Validator.spendEscrow),
      );
    }),
  );

  it.effect("republishes a recorded ref that sits at a spendable address", () =>
    Effect.gen(function* () {
      const { context, network } = yield* setupBase();
      const { lucid, emulator } = context;
      selectWalletFromSeed(lucid, context.users.admin.seedPhrase);
      const address = yield* Effect.promise(() => lucid.wallet().address());

      // The live Preprod state as of 2026-08-01: a correct script hash parked
      // at the deployer's own wallet. Reuse must NOT accept it.
      const parkTx = yield* Effect.promise(() =>
        lucid
          .newTx()
          .pay.ToAddressWithData(
            address,
            undefined,
            {},
            escrowV2Validator.spendEscrow,
          )
          .complete(),
      );
      const parkSigned = yield* Effect.promise(() =>
        parkTx.sign.withWallet().complete(),
      );
      const parkHash = yield* Effect.promise(() => parkSigned.submit());
      yield* advanceBlock(emulator);
      const walletRef = { txHash: parkHash, outputIndex: 0 };

      const result = yield* deployModuleScripts(
        { escrowV2: escrowV2Validator.spendEscrow },
        lucid,
        {
          existing: { escrowV2: walletRef },
          awaitSettled: emulatorSettle(emulator),
        },
      );

      expect(result.status.escrowV2).toBe("deployed");
      expect(result.refs.escrowV2).not.toEqual(walletRef);

      const [republished] = yield* Effect.promise(() =>
        lucid.utxosByOutRef([result.refs.escrowV2!]),
      );
      expect(republished.address).toBe(
        validatorToAddress(network, alwaysFailsValidator.elseAlwaysFails),
      );
    }),
  );

  it.effect("never spends a reference script the wallet already holds", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const { lucid, emulator } = context;
      selectWalletFromSeed(lucid, context.users.admin.seedPhrase);
      const address = yield* Effect.promise(() => lucid.wallet().address());

      // Park a reference script in the WALLET — the exact custody mistake that
      // let coin selection consume the savings ref on Preprod. It carries the
      // largest balance in the wallet, so a selector that does not exclude
      // reference scripts reaches for it first.
      const parkTx = yield* Effect.promise(() =>
        lucid
          .newTx()
          .pay.ToAddressWithData(
            address,
            undefined,
            { lovelace: 600_000_000n },
            escrowV2Validator.spendEscrow,
          )
          .complete(),
      );
      const parkSigned = yield* Effect.promise(() =>
        parkTx.sign.withWallet().complete(),
      );
      const parkHash = yield* Effect.promise(() => parkSigned.submit());
      yield* advanceBlock(emulator);

      yield* deployModuleScripts(
        { savings: savingsVaultValidator.spendVault },
        lucid,
        { awaitSettled: emulatorSettle(emulator) },
      );

      const [parked] = yield* Effect.promise(() =>
        lucid.utxosByOutRef([{ txHash: parkHash, outputIndex: 0 }]),
      );
      expect(parked?.scriptRef).toBeTruthy();
    }),
  );

  it.effect("fails before any transaction when nothing is requested", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      selectWalletFromSeed(context.lucid, context.users.admin.seedPhrase);

      const err = yield* Effect.flip(deployModuleScripts({}, context.lucid));
      expect(err._tag).toBe("SetupError");
      if (err._tag === "SetupError")
        expect(err.message).toContain("no scripts");
    }),
  );

  it.effect("fails before any transaction on an undeployable script", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      selectWalletFromSeed(context.lucid, context.users.admin.seedPhrase);

      const oversized = {
        type: "PlutusV3" as const,
        script: "00".repeat(MAX_REF_SCRIPT_BYTES + 1),
      };
      const err = yield* Effect.flip(
        deployModuleScripts({ savings: oversized }, context.lucid),
      );
      expect(err._tag).toBe("SetupError");
      if (err._tag === "SetupError")
        expect(err.message).toContain("can never go on-chain");
    }),
  );
});
