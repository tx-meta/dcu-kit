import { LucidEvolution } from "@lucid-evolution/lucid";
import { makeReturn } from "../core/utils/index.js";
import { buildProtocol, Protocol } from "../core/validators/constants.js";

// Endpoint Imports
import {
  unsignedCreateAccountTxProgram,
  CreateAccountConfig,
} from "./createAccount.js";
import {
  unsignedUpdateAccountTxProgram,
  UpdateAccountConfig,
} from "./updateAccount.js";
import {
  unsignedDeleteAccountTxProgram,
  DeleteAccountConfig,
} from "./deleteAccount.js";
import {
  unsignedCreateGroupTxProgram,
  CreateGroupConfig,
} from "./createGroup.js";
import {
  unsignedUpdateGroupTxProgram,
  UpdateGroupConfig,
} from "./updateGroup.js";
import {
  unsignedDeleteGroupTxProgram,
  DeleteGroupConfig,
} from "./deleteGroup.js";
import { unsignedJoinGroupTxProgram, JoinGroupConfig } from "./joinGroup.js";
import {
  unsignedDistributePayoutTxProgram,
  DistributePayoutConfig,
} from "./distributePayout.js";
import { unsignedStartGroupTxProgram, StartGroupConfig } from "./startGroup.js";
import { unsignedExitGroupTxProgram, ExitGroupConfig } from "./exitGroup.js";
import {
  unsignedTerminateGroupTxProgram,
  TerminateGroupConfig,
} from "./terminateGroup.js";
import { unsignedContributeTxProgram, ContributeConfig } from "./contribute.js";
import {
  unsignedUpdatePayoutCredentialTxProgram,
  UpdatePayoutCredentialConfig,
} from "./updatePayoutCredential.js";
import {
  unsignedExtendGraceWindowTxProgram,
  ExtendGraceWindowConfig,
} from "./extendGraceWindow.js";
import { unsignedNextCycleTxProgram, NextCycleConfig } from "./nextCycle.js";
import { unsignedClaimPayoutTxProgram, ClaimPayoutConfig } from "./claimPayout.js";

// ─── Account create/update (settings-independent — account validator is a root) ──

/** Creates a DCU Account. */
export const createAccount = (
  lucid: LucidEvolution,
  config: CreateAccountConfig,
) => makeReturn(unsignedCreateAccountTxProgram(lucid, config));

/** Updates a DCU Account. */
export const updateAccount = (
  lucid: LucidEvolution,
  config: UpdateAccountConfig,
) => makeReturn(unsignedUpdateAccountTxProgram(lucid, config));

// NOTE: deleteAccount is NOT here — it scans the deployment's treasury for active
// memberships before burning, so it needs the protocol context and lives inside
// createDcuSdk below.

// ─── Group + treasury endpoints (bound to a deployment's protocol context) ───────

/**
 * Build the DCU group/treasury endpoints for a deployment, bound to its protocol
 * context (validators/policies derived from the deployment's settings policy).
 *
 * `settingsPolicy` is the policy ID of the singleton settings NFT minted by
 * `initializeSettings` (see admin module). Because the treasury validator is
 * parameterized by it (P5 trusted binding), the group/treasury endpoints cannot be
 * static module constants — they are produced here, once per deployment.
 *
 * @example
 * const sdk = createDcuSdk(settingsPolicy);
 * await sdk.joinGroup(lucid, config).unsafeRun();
 */
export const createDcuSdk = (settingsPolicy: string) => {
  const protocol: Protocol = buildProtocol(settingsPolicy);
  return {
    protocol,

    /** Deletes a DCU Account (rejects if it has active memberships in this deployment). */
    deleteAccount: (lucid: LucidEvolution, config: DeleteAccountConfig) =>
      makeReturn(unsignedDeleteAccountTxProgram(protocol, lucid, config)),

    createGroup: (lucid: LucidEvolution, config: CreateGroupConfig) =>
      makeReturn(unsignedCreateGroupTxProgram(protocol, lucid, config)),

    updateGroup: (lucid: LucidEvolution, config: UpdateGroupConfig) =>
      makeReturn(unsignedUpdateGroupTxProgram(protocol, lucid, config)),

    deleteGroup: (lucid: LucidEvolution, config: DeleteGroupConfig) =>
      makeReturn(unsignedDeleteGroupTxProgram(protocol, lucid, config)),

    joinGroup: (lucid: LucidEvolution, config: JoinGroupConfig) =>
      makeReturn(unsignedJoinGroupTxProgram(protocol, lucid, config)),

    startGroup: (lucid: LucidEvolution, config: StartGroupConfig) =>
      makeReturn(unsignedStartGroupTxProgram(protocol, lucid, config)),

    distributePayout: (lucid: LucidEvolution, config: DistributePayoutConfig) =>
      makeReturn(unsignedDistributePayoutTxProgram(protocol, lucid, config)),

    exitGroup: (lucid: LucidEvolution, config: ExitGroupConfig) =>
      makeReturn(unsignedExitGroupTxProgram(protocol, lucid, config)),

    terminateGroup: (lucid: LucidEvolution, config: TerminateGroupConfig) =>
      makeReturn(unsignedTerminateGroupTxProgram(protocol, lucid, config)),

    contribute: (lucid: LucidEvolution, config: ContributeConfig) =>
      makeReturn(unsignedContributeTxProgram(protocol, lucid, config)),

    updatePayoutCredential: (
      lucid: LucidEvolution,
      config: UpdatePayoutCredentialConfig,
    ) =>
      makeReturn(
        unsignedUpdatePayoutCredentialTxProgram(protocol, lucid, config),
      ),

    extendGraceWindow: (
      lucid: LucidEvolution,
      config: ExtendGraceWindowConfig,
    ) => makeReturn(unsignedExtendGraceWindowTxProgram(protocol, lucid, config)),

    nextCycle: (lucid: LucidEvolution, config: NextCycleConfig) =>
      makeReturn(unsignedNextCycleTxProgram(protocol, lucid, config)),

    claimPayout: (lucid: LucidEvolution, config: ClaimPayoutConfig) =>
      makeReturn(unsignedClaimPayoutTxProgram(protocol, lucid, config)),
  };
};

/** The bound group/treasury endpoint set returned by {@link createDcuSdk}. */
export type DcuSdk = ReturnType<typeof createDcuSdk>;
