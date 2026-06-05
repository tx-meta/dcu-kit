/**
 * Bound-SDK loader for examples.
 *
 * Under P5 the treasury/group validators are parameterized by the deployment's
 * settings policy, so they are no longer static module constants. Every example
 * that touches a group or treasury must build its endpoints from the settings
 * policy via `createDcuSdk(settingsPolicy)`.
 *
 * `loadSdk()` reads the settings policy that `initialize-settings.ts` recorded in
 * state.json and returns the bound endpoint set. The returned object also exposes
 * `.protocol` (groupPolicyId, treasuryPolicyId, validators, settingsUnit, ...).
 *
 * Bootstrap order on a fresh deployment:
 *   1. pnpm run initialize-settings   — mints the singleton settings NFT
 *   2. pnpm run deploy-scripts        — deploys treasury/group reference scripts
 *   3. pnpm run create-group / create-account / join-group / ...
 */

import { createDcuSdk, DcuSdk } from "@tx-meta/dcu-sdk";
import { loadState } from "./state.js";

/**
 * Builds the deployment-bound SDK from the settings policy in state.json.
 * Throws a clear, actionable error when settings have not been initialized yet.
 */
export function loadSdk(): DcuSdk {
  const { settingsPolicy } = loadState();
  if (!settingsPolicy) {
    throw new Error(
      "No settingsPolicy in state.json.\n" +
        "Initialize the protocol settings first:\n" +
        "  pnpm run initialize-settings",
    );
  }
  return createDcuSdk(settingsPolicy);
}
