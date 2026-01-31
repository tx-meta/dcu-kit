import {
  applyDoubleCborEncoding,
  applyParamsToScript,
  Data,
  Script,
} from "@lucid-evolution/lucid";
import { Effect, Option, pipe } from "effect";
import { BlueprintLoadError, ValidatorNotFoundError } from "../errors.js";

export type ValidatorMap = Record<string, Script>;

export interface BlueprintValidator {
  title: string;
  compiledCode: string;
}

export interface Blueprint {
  validators: BlueprintValidator[];
}

export const readValidators = (
  blueprint: Blueprint,
  params?: Data[] | null
): Effect.Effect<ValidatorMap, BlueprintLoadError> =>
  Effect.gen(function* () {
    if (!blueprint.validators) {
      yield* Effect.fail(
        new BlueprintLoadError({
          path: "in-memory blueprint",
          error: "Blueprint definition missing 'validators' field",
        })
      );
    }

    const validators: ValidatorMap = {};

    for (const v of blueprint.validators) {
      const title = v.title;
      if (!title) continue;

      const scriptCode = v.compiledCode;
      if (!scriptCode) {
        yield* Effect.fail(
          new BlueprintLoadError({
            path: "in-memory blueprint",
            error: `Validator '${title}' missing compiledCode`,
          })
        );
      }

      let scriptHex = applyDoubleCborEncoding(scriptCode);

      if (params && params.length > 0) {
        try {
          scriptHex = applyParamsToScript(scriptHex, params);
        } catch (error) {
          // Ignore if parameters cannot be applied, strictly speaking we might want to fail
        }
      }

      validators[title] = {
        type: "PlutusV3",
        script: scriptHex,
      };
    }

    return validators;
  });

export const getScript = (
  validators: ValidatorMap,
  title: string
): Effect.Effect<Script, ValidatorNotFoundError> =>
  pipe(
    Option.fromNullable(validators[title]),
    Effect.mapError(
      () => new ValidatorNotFoundError({ validatorName: title })
    )
  );
