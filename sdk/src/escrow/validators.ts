import { mintingPolicyToId, Script } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import blueprint from "./plutus.json" with { type: "json" };
import {
  Blueprint,
  getScript,
  readValidators,
} from "../core/validators/reader.js";

// The escrow blueprint is standalone (own Aiken project) — it never rides on the
// DCU deployment's plutus.json, so escrow work can't ripple DCU hashes.
const validators = Effect.runSync(
  readValidators(blueprint as unknown as Blueprint),
);

const raw = (title: string): Script =>
  Effect.runSync(getScript(validators, title));

// One multi-purpose validator: the same script hash mints the state token and
// guards the escrow address (self-coupled, spec 3.3).
export const escrowValidator = {
  spendEscrow: raw("escrow_validator.escrow_validator.spend"),
  mintEscrow: raw("escrow_validator.escrow_validator.mint"),
};

export const escrowPolicyId = mintingPolicyToId(escrowValidator.mintEscrow);
