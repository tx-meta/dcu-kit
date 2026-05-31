import { LucidEvolution } from "@lucid-evolution/lucid";
import { makeReturn } from "../core/utils/index.js";

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

/**
 * Creates a DCU Account.
 */
export const createAccount = (
  lucid: LucidEvolution,
  config: CreateAccountConfig,
) => makeReturn(unsignedCreateAccountTxProgram(lucid, config));

/**
 * Updates a DCU Account.
 */
export const updateAccount = (
  lucid: LucidEvolution,
  config: UpdateAccountConfig,
) => makeReturn(unsignedUpdateAccountTxProgram(lucid, config));

/**
 * Deletes a DCU Account.
 */
export const deleteAccount = (
  lucid: LucidEvolution,
  config: DeleteAccountConfig,
) => makeReturn(unsignedDeleteAccountTxProgram(lucid, config));

/**
 * Creates a generic DCU Group.
 */
export const createGroup = (lucid: LucidEvolution, config: CreateGroupConfig) =>
  makeReturn(unsignedCreateGroupTxProgram(lucid, config));

/**
 * Updates a DCU Group's parameters.
 */
export const updateGroup = (lucid: LucidEvolution, config: UpdateGroupConfig) =>
  makeReturn(unsignedUpdateGroupTxProgram(lucid, config));

/**
 * Deletes (deactivates) a DCU Group.
 */
export const deleteGroup = (lucid: LucidEvolution, config: DeleteGroupConfig) =>
  makeReturn(unsignedDeleteGroupTxProgram(lucid, config));

/**
 * Joins a user to a DCU Group.
 */
export const joinGroup = (lucid: LucidEvolution, config: JoinGroupConfig) =>
  makeReturn(unsignedJoinGroupTxProgram(lucid, config));

/**
 * Distributes payouts from a DCU Group Treasury to the assigned member.
 */
export const distributePayout = (
  lucid: LucidEvolution,
  config: DistributePayoutConfig,
) => makeReturn(unsignedDistributePayoutTxProgram(lucid, config));

/**
 * Exits a member from a DCU Group, claiming refunds or paying penalties.
 */
export const exitGroup = (lucid: LucidEvolution, config: ExitGroupConfig) =>
  makeReturn(unsignedExitGroupTxProgram(lucid, config));

/**
 * Exits a member from a DCU Group, claiming refunds or paying penalties.
 */

/**
 * Starts a DCU Group, sealing membership and fixing the rotation schedule.
 */
export const startGroup = (lucid: LucidEvolution, config: StartGroupConfig) =>
  makeReturn(unsignedStartGroupTxProgram(lucid, config));

/**
 * Terminates a group, burning the treasury membership token.
 */
export const terminateGroup = (
  lucid: LucidEvolution,
  config: TerminateGroupConfig,
) => makeReturn(unsignedTerminateGroupTxProgram(lucid, config));

/**
 * Tops up a member's treasury UTxO balance (Contribute redeemer).
 */
export const contribute = (lucid: LucidEvolution, config: ContributeConfig) =>
  makeReturn(unsignedContributeTxProgram(lucid, config));

/**
 * Updates the member's payout destination credential.
 */
export const updatePayoutCredential = (
  lucid: LucidEvolution,
  config: UpdatePayoutCredentialConfig,
) => makeReturn(unsignedUpdatePayoutCredentialTxProgram(lucid, config));

/**
 * Admin grants a grace window extension to a member in InsufficientCollateralState.
 */
export const extendGraceWindow = (
  lucid: LucidEvolution,
  config: ExtendGraceWindowConfig,
) => makeReturn(unsignedExtendGraceWindowTxProgram(lucid, config));

/**
 * Resets a mature ROSCA group for another rotation cycle.
 * Requires all rounds to be distributed. Members re-deposit via contribute,
 * then admin calls startGroup again.
 */
export const nextCycle = (lucid: LucidEvolution, config: NextCycleConfig) =>
  makeReturn(unsignedNextCycleTxProgram(lucid, config));
