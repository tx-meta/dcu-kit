import {
  Credential,
  mintingPolicyToId,
  Network,
  Script,
  scriptHashToCredential,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { PlutusArtifact } from "../loader.js";
import { getScript, readValidators } from "./reader.js";

export interface ValidatorInfo {
  script: Script;
  address: string;
  policyId: string;
}

export interface SpendingValidatorInfo {
    script: Script;
    address: string;
}

export interface MintingValidatorInfo {
    script: Script;
    policyId: string;
}

export interface DcuValidators {
  account: {
    spend: SpendingValidatorInfo;
    mint: MintingValidatorInfo;
  };
  group: {
    spend: SpendingValidatorInfo;
    mint: MintingValidatorInfo;
  };
  treasury: {
    spend: SpendingValidatorInfo;
    mint: MintingValidatorInfo;
  };
}

export const makeValidators = (
  network: Network
): Effect.Effect<DcuValidators, Error> =>
  Effect.gen(function* () {
    const validators = yield* readValidators(PlutusArtifact);

    const getSpending = (title: string): SpendingValidatorInfo => {
      const script = Effect.runSync(getScript(validators, title));
      return {
        script,
        address: validatorToAddress(network, script),
      };
    };

    const getMinting = (title: string): MintingValidatorInfo => {
      const script = Effect.runSync(getScript(validators, title));
      return {
        script,
        policyId: mintingPolicyToId(script),
      };
    };

    return {
      account: {
        spend: getSpending("account_validator.account.spend"),
        mint: getMinting("account_validator.account.mint"),
      },
      group: {
        spend: getSpending("group_validator.group.spend"),
        mint: getMinting("group_validator.group.mint"),
      },
      treasury: {
        spend: getSpending("treasury_validator.treasury.spend"),
        mint: getMinting("treasury_validator.treasury.mint"),
      },
    };
  });
