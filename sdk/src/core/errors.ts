/**
 * DCU SDK Error Types
 * 
 * Effect-style error handling using tagged union types.
 * Each error has a `_tag` field for discrimination and additional context fields.
 */

// --- UTxO Errors ---

export type UtxoNotFoundError = {
  readonly _tag: "UtxoNotFound";
  readonly tokenName: string;
  readonly address: string;
};

export type InsufficientUtxosError = {
  readonly _tag: "InsufficientUtxos";
  readonly required: number;
  readonly available: number;
};

// --- Datum Errors ---

export type InvalidDatumError = {
  readonly _tag: "InvalidDatum";
  readonly field: string;
  readonly reason: string;
};

export type DatumDecodingError = {
  readonly _tag: "DatumDecodingError";
  readonly utxoId: string;
  readonly error: string;
};

// --- Transaction Errors ---

export type TransactionBuildError = {
  readonly _tag: "TransactionBuildError";
  readonly operation: string;
  readonly error: string;
};

export type TransactionSignError = {
  readonly _tag: "TransactionSignError";
  readonly error: string;
};

export type TransactionSubmitError = {
  readonly _tag: "TransactionSubmitError";
  readonly txHash?: string;
  readonly error: string;
};

// --- Validator Errors ---

export type ValidatorNotFoundError = {
  readonly _tag: "ValidatorNotFound";
  readonly validatorName: string;
};

export type BlueprintLoadError = {
  readonly _tag: "BlueprintLoadError";
  readonly path: string;
  readonly error: string;
};

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
  | BlueprintLoadError;

// --- Error Constructors ---

export const DcuErrors = {
  utxoNotFound: (tokenName: string, address: string): UtxoNotFoundError => ({
    _tag: "UtxoNotFound",
    tokenName,
    address,
  }),

  insufficientUtxos: (required: number, available: number): InsufficientUtxosError => ({
    _tag: "InsufficientUtxos",
    required,
    available,
  }),

  invalidDatum: (field: string, reason: string): InvalidDatumError => ({
    _tag: "InvalidDatum",
    field,
    reason,
  }),

  datumDecodingError: (utxoId: string, error: string): DatumDecodingError => ({
    _tag: "DatumDecodingError",
    utxoId,
    error,
  }),

  transactionBuildError: (operation: string, error: string): TransactionBuildError => ({
    _tag: "TransactionBuildError",
    operation,
    error,
  }),

  transactionSignError: (error: string): TransactionSignError => ({
    _tag: "TransactionSignError",
    error,
  }),

  transactionSubmitError: (error: string, txHash?: string): TransactionSubmitError => ({
    _tag: "TransactionSubmitError",
    error,
    txHash,
  }),

  validatorNotFound: (validatorName: string): ValidatorNotFoundError => ({
    _tag: "ValidatorNotFound",
    validatorName,
  }),

  blueprintLoadError: (path: string, error: string): BlueprintLoadError => ({
    _tag: "BlueprintLoadError",
    path,
    error,
  }),
};
