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

export class InsufficientUtxosError extends Data.TaggedError("InsufficientUtxosError")<{
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

export class TransactionBuildError extends Data.TaggedError("TransactionBuildError")<{
  readonly operation: string;
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class TransactionSignError extends Data.TaggedError("TransactionSignError")<{
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

export class TransactionSubmitError extends Data.TaggedError("TransactionSubmitError")<{
  readonly txHash?: string;
  readonly error: string;
  readonly message?: string;
  readonly cause?: unknown;
}> {}

// --- Validator Errors ---

export class ValidatorNotFoundError extends Data.TaggedError("ValidatorNotFoundError")<{
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

// --- Union Type ---

export type DcuError =
  | UtxoNotFoundError
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
  | LucidError;
