import {
  credentialToAddress,
  Data,
  getAddressDetails,
  Network,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { CredentialSchema } from "../core/types.js";
import { ConfigurationError } from "../core/errors.js";

// --- On-chain Address (mirrors Aiken's cardano/address.Address) ---
// stake_credential: None | Some(Inline(cred)) | Some(Pointer(slot, tx, cert)).
export const StakeCredentialSchema = Data.Enum([
  Data.Object({ Inline: Data.Tuple([CredentialSchema]) }),
  Data.Object({
    Pointer: Data.Tuple([Data.Integer(), Data.Integer(), Data.Integer()]),
  }),
]);

export const AddressSchema = Data.Object({
  payment_credential: CredentialSchema,
  stake_credential: Data.Nullable(StakeCredentialSchema),
});
export type AddressD = Data.Static<typeof AddressSchema>;
export const AddressD = AddressSchema as unknown as AddressD;

export const EscrowDatumSchema = Data.Object({
  /** Refund destination + abort co-authority (full address, stake pinned). */
  funder: AddressSchema,
  /** Tranche destination + abort co-authority (full address, stake pinned). */
  beneficiary: AddressSchema,
  /** Release authority — never receives funds. VK or script (e.g. multisig). */
  verifier: CredentialSchema,
  /** Policy ID of the escrowed asset. Empty string (`""`) means ADA. */
  asset_policy: Data.Bytes(),
  /** Asset name of the escrowed asset. Empty string (`""`) means ADA. */
  asset_name: Data.Bytes(),
  /** Tranche amounts in the asset's smallest unit; fixed at create; max 100. */
  milestones: Data.Array(Data.Integer()),
  /** Tranches released so far. 0 at creation; advances by exactly 1 per release. */
  released_count: Data.Integer(),
  /** POSIX ms. Releases only before; funder reclaim only strictly after. */
  expiry: Data.Integer(),
});
export type EscrowDatum = Data.Static<typeof EscrowDatumSchema>;
export const EscrowDatum = EscrowDatumSchema as unknown as EscrowDatum;

export const EscrowSpendRedeemerSchema = Data.Enum([
  Data.Object({
    Release: Data.Object({
      escrow_input_index: Data.Integer(),
      continuation_index: Data.Integer(),
      payout_index: Data.Integer(),
    }),
  }),
  Data.Object({
    Reclaim: Data.Object({
      escrow_input_index: Data.Integer(),
      refund_index: Data.Integer(),
    }),
  }),
  Data.Object({
    Abort: Data.Object({ escrow_input_index: Data.Integer() }),
  }),
]);
export type EscrowSpendRedeemer = Data.Static<typeof EscrowSpendRedeemerSchema>;
export const EscrowSpendRedeemer =
  EscrowSpendRedeemerSchema as unknown as EscrowSpendRedeemer;

export const EscrowMintRedeemerSchema = Data.Enum([
  Data.Object({
    CreateEscrow: Data.Object({
      seed_input_index: Data.Integer(),
      escrow_output_index: Data.Integer(),
    }),
  }),
  Data.Literal("BurnEscrow"),
]);
export type EscrowMintRedeemer = Data.Static<typeof EscrowMintRedeemerSchema>;
export const EscrowMintRedeemer =
  EscrowMintRedeemerSchema as unknown as EscrowMintRedeemer;

/** Converts a bech32 address to the on-chain Address representation. */
export const toOnchainAddress = (
  bech32: string,
): Effect.Effect<AddressD, ConfigurationError> =>
  Effect.try({
    try: () => {
      const details = getAddressDetails(bech32);
      const pc = details.paymentCredential;
      if (!pc) throw new Error("address has no payment credential");
      const payment_credential =
        pc.type === "Key"
          ? { VerificationKey: [pc.hash] as [string] }
          : { Script: [pc.hash] as [string] };
      const sc = details.stakeCredential;
      const stake_credential = sc
        ? {
            Inline: [
              sc.type === "Key"
                ? { VerificationKey: [sc.hash] as [string] }
                : { Script: [sc.hash] as [string] },
            ] as [AddressD["payment_credential"]],
          }
        : null;
      return { payment_credential, stake_credential };
    },
    catch: (e) =>
      new ConfigurationError({
        configKey: "address",
        message: `Cannot convert '${bech32}' to an on-chain address: ${String(e)}`,
      }),
  });

/** Converts an on-chain Address (from an escrow datum) back to bech32. */
export const fromOnchainAddress = (
  network: Network,
  address: AddressD,
): Effect.Effect<string, ConfigurationError> =>
  Effect.try({
    try: () => {
      const pc = address.payment_credential;
      const payment =
        "VerificationKey" in pc
          ? { type: "Key" as const, hash: pc.VerificationKey[0] }
          : { type: "Script" as const, hash: pc.Script[0] };
      const sc = address.stake_credential;
      if (sc === null) return credentialToAddress(network, payment);
      if (!("Inline" in sc))
        throw new Error("pointer stake credentials are not supported");
      const inner = sc.Inline[0];
      const stake =
        "VerificationKey" in inner
          ? { type: "Key" as const, hash: inner.VerificationKey[0] }
          : { type: "Script" as const, hash: inner.Script[0] };
      return credentialToAddress(network, payment, stake);
    },
    catch: (e) =>
      new ConfigurationError({
        configKey: "address",
        message: `Cannot convert on-chain address to bech32: ${String(e)}`,
      }),
  });
