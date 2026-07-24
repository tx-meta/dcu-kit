import registryJson from "./validator-registry.json" with { type: "json" };

/**
 * The validator registry — the reviewed record tying this SDK version to the
 * exact validator bytes it ships, per family.
 *
 * The root `validator-registry.json` is the source of truth; this module reads
 * the bundled copy that `scripts/update-validator-registry.mjs` keeps in sync
 * (CI fails if the two differ). Rules for changing it live in `VERSIONING.md`.
 */

export type FamilyName = "rosca" | "escrow" | "savings" | "governance";

/**
 * `launch` — approved for mainnet deployment.
 * `experimental` — not externally audited; Preprod/emulator only.
 */
export type FamilyStatus = "launch" | "experimental";

export interface RegistryFamily {
  status: FamilyStatus;
  /** Repo path of the blueprint the SDK bundles for this family. */
  blueprint: string;
  /** Repo path of the aiken build output the bundled blueprint must match. */
  onchainSource: string;
  plutusVersion: string;
  /** sha256 fingerprint of each validator's compiledCode, keyed by title. */
  validators: Record<string, string>;
  deployments: Record<string, { date: string; note: string }>;
}

export interface ValidatorRegistry {
  registryVersion: number;
  /** The sdk/package.json version these fingerprints were recorded for. */
  sdkVersion: string;
  families: Record<FamilyName, RegistryFamily>;
  history: Array<{
    date: string;
    sdkVersion: string;
    changed: string[];
    note: string;
  }>;
}

export const validatorRegistry = registryJson as unknown as ValidatorRegistry;

export const familyStatus = (family: FamilyName): FamilyStatus =>
  validatorRegistry.families[family].status;

/** Families approved for mainnet deployment. */
export const launchFamilies = (): FamilyName[] =>
  (Object.keys(validatorRegistry.families) as FamilyName[]).filter(
    (f) => familyStatus(f) === "launch",
  );

/**
 * The launch-surface freeze: a family may be deployed to Mainnet only when
 * the registry marks it `launch`. Any network other than Mainnet is open.
 */
export const isDeployAllowed = (
  family: FamilyName,
  network: string | null | undefined,
): boolean => network !== "Mainnet" || familyStatus(family) === "launch";
