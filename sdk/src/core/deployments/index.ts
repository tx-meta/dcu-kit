import preprod from "./preprod.json" with { type: "json" };
import { ConfigurationError } from "../errors.js";

export type DeploymentNetwork = "Preprod" | "Mainnet";

export type RefScriptEntry = {
  txHash: string;
  outputIndex: number;
  scriptHash: string;
};

export type DeploymentManifest = {
  network: string;
  verifiedAt: string;
  sdkVersion: string;
  settingsPolicy: string;
  deployAddress: string;
  refScripts: Record<string, RefScriptEntry>;
  governance: {
    seed: { txHash: string; outputIndex: number };
    settingsPolicy: string;
    govPolicy: string;
    gateHash: string;
    votingStakeHash: string;
    /** The eligibility policy: holding a token of it makes a voter. */
    memberPolicy: string;
    /** The savings fund this instance governs (its state NFT name). */
    governedFund: string;
  };
};

const MANIFESTS: Partial<Record<DeploymentNetwork, DeploymentManifest>> = {
  Preprod: preprod as DeploymentManifest,
};

/**
 * The published deployment coordinates for a network. Consumers (Kyama) read
 * ref-script outrefs from here instead of hardcoding them.
 */
export const loadDeployment = (
  network: DeploymentNetwork,
): DeploymentManifest => {
  const m = MANIFESTS[network];
  if (!m)
    throw new ConfigurationError({
      configKey: "network",
      message: `no deployment manifest for network ${network}`,
    });
  return m;
};
