/**
 * DCU SDK Error Types
 *
 * Effect-style error handling using tagged union types.
 * Each error has a `_tag` field for discrimination and additional context fields.
 */

import { Data } from "effect";

// --- Base Error Types ---

export type GenericErrorFields = {
  readonly message?: string;
  readonly cause?: unknown;
};

export class LucidError extends Data.TaggedError("LucidError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// --- UTxO Errors ---

export class UtxoNotFoundError extends Data.TaggedError("UtxoNotFoundError")<{
  readonly tokenName: string;
  readonly address: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

/**
 * A unit resolved to more than one live UTxO, so no single UTxO is implied.
 *
 * Reachable in normal use: a member's treasury token name is their account (222)
 * token name, which the validator requires (dcu/treasury_validation
 * `member_has_user_token`). One identity in N groups therefore has N live UTxOs
 * under one unit. Unlike `UtxoNotFoundError` this is permanent, so callers must
 * not retry it. Supply the owning group to disambiguate.
 */
export class AmbiguousUtxoError extends Data.TaggedError("AmbiguousUtxoError")<{
  readonly unit: string;
  readonly candidates: number;
  /** `group_reference_tokenname` of each candidate, when the datums were decoded. */
  readonly groups?: readonly string[];
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class InsufficientUtxosError extends Data.TaggedError(
  "InsufficientUtxosError",
)<{
  readonly required: number;
  readonly available: number;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

// --- Datum Errors ---

export class InvalidDatumError extends Data.TaggedError("InvalidDatumError")<{
  readonly field: string;
  readonly reason: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class DatumDecodingError extends Data.TaggedError("DatumDecodingError")<{
  readonly utxoId: string;
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

// --- Transaction Errors ---

export class TransactionBuildError extends Data.TaggedError(
  "TransactionBuildError",
)<{
  readonly operation: string;
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class TransactionSignError extends Data.TaggedError(
  "TransactionSignError",
)<{
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class TransactionSubmitError extends Data.TaggedError(
  "TransactionSubmitError",
)<{
  readonly txHash?: string;
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

// --- Validator Errors ---

export class ValidatorNotFoundError extends Data.TaggedError(
  "ValidatorNotFoundError",
)<{
  readonly validatorName: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class BlueprintLoadError extends Data.TaggedError("BlueprintLoadError")<{
  readonly path: string;
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly configKey: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class SetupError extends Data.TaggedError("SetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A supplied reference-script UTxO does not match the deployment's compiled
 * validator hash (stale/wrong ref), or carries no script at all. Surfaces the
 * otherwise-cryptic on-chain "script hash mismatch" as a typed, early failure.
 */
export class ReferenceScriptMismatchError extends Data.TaggedError(
  "ReferenceScriptMismatchError",
)<{
  readonly validator:
    | "treasury"
    | "group"
    | "treasuryRounds"
    | "treasuryLifecycle"
    | "treasuryRecovery"
    | "treasuryReserve";
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly reason: string;
}> {}

// --- Union Type ---

export type DcuError =
  | UtxoNotFoundError
  | AmbiguousUtxoError
  | InsufficientUtxosError
  | InvalidDatumError
  | DatumDecodingError
  | TransactionBuildError
  | TransactionSignError
  | TransactionSubmitError
  | ValidatorNotFoundError
  | BlueprintLoadError
  | ConfigurationError
  | SetupError
  | ReferenceScriptMismatchError
  | LucidError;
