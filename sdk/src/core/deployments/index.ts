import preprod from "./preprod.json" with { type: "json" };

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
  };
};

const MANIFESTS: Record<string, DeploymentManifest> = {
  Preprod: preprod as DeploymentManifest,
};

/**
 * The published deployment coordinates for a network. Consumers (Kyama) read
 * ref-script outrefs from here instead of hardcoding them.
 */
export const loadDeployment = (network: string): DeploymentManifest => {
  const m = MANIFESTS[network];
  if (!m) throw new Error(`no deployment manifest for network ${network}`);
  return m;
};
