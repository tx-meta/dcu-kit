import type { TreasuryFamily } from "./validators/constants.js";
import type { ScriptRefs } from "./scripts.js";
import { treasuryFamilyReferenceKey } from "./familyWithdraw.js";

export type RoscaOperation = "beginRecommit" | "distributeRound" | "startGroup";

type OperationDescriptor = {
  direct: readonly (keyof ScriptRefs)[];
  treasuryFamilies: readonly TreasuryFamily[];
};

/**
 * Validator families used by each size-sensitive ROSCA operation. Family
 * reference names are deliberately not repeated here: they are generated from
 * `treasuryFamilyReferenceKey`, the same map used by `attachFamilyWithdrawal`.
 */
export const operationDescriptors: Readonly<
  Record<RoscaOperation, OperationDescriptor>
> = {
  beginRecommit: { direct: ["group"], treasuryFamilies: [] },
  startGroup: { direct: ["group"], treasuryFamilies: [] },
  distributeRound: {
    direct: ["treasury", "group"],
    treasuryFamilies: ["rounds"],
  },
};

const deriveRequirements = (
  descriptor: OperationDescriptor,
): readonly (keyof ScriptRefs)[] =>
  Array.from(
    new Set([
      ...descriptor.direct,
      ...descriptor.treasuryFamilies.map(
        (family) => treasuryFamilyReferenceKey[family],
      ),
    ]),
  );

/** Generated live-network reference requirements, keyed by endpoint operation. */
export const operationRequirements: Readonly<
  Record<RoscaOperation, readonly (keyof ScriptRefs)[]>
> = Object.fromEntries(
  Object.entries(operationDescriptors).map(([operation, descriptor]) => [
    operation,
    deriveRequirements(descriptor),
  ]),
) as Record<RoscaOperation, readonly (keyof ScriptRefs)[]>;

export const requirementsFor = (
  operation: RoscaOperation,
): readonly (keyof ScriptRefs)[] => operationRequirements[operation];
