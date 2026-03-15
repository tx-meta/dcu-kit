
import { LucidEvolution } from "@lucid-evolution/lucid";
import { makeReturn } from "../core/utils/index.js";

// Endpoint Imports
import { unsignedCreateAccountTxProgram, CreateAccountConfig } from "./createAccount.js";
import { unsignedUpdateAccountTxProgram, UpdateAccountConfig } from "./updateAccount.js";
import { unsignedDeleteAccountTxProgram, DeleteAccountConfig } from "./deleteAccount.js";
import { unsignedCreateGroupTxProgram, CreateGroupConfig } from "./createGroup.js";
import { unsignedUpdateGroupTxProgram, UpdateGroupConfig } from "./updateGroup.js";
import { unsignedDeleteGroupTxProgram, DeleteGroupConfig } from "./deleteGroup.js";
import { unsignedJoinGroupTxProgram, JoinGroupConfig } from "./joinGroup.js";
import { unsignedDistributePayoutTxProgram, DistributePayoutConfig } from "./distributePayout.js";
import { unsignedMemberWithdrawTxProgram, MemberWithdrawConfig } from "./memberWithdraw.js";
import { unsignedExitGroupTxProgram, ExitGroupConfig } from "./exitGroup.js";
import { unsignedTerminateGroupTxProgram, TerminateGroupConfig } from "./terminateGroup.js";

/**
 * Creates a DCU Account.
 */
export const createAccount = (lucid: LucidEvolution, config: CreateAccountConfig) =>
    makeReturn(unsignedCreateAccountTxProgram(lucid, config));

/**
 * Updates a DCU Account.
 */
export const updateAccount = (lucid: LucidEvolution, config: UpdateAccountConfig) =>
    makeReturn(unsignedUpdateAccountTxProgram(lucid, config));

/**
 * Deletes a DCU Account.
 */
export const deleteAccount = (lucid: LucidEvolution, config: DeleteAccountConfig) =>
    makeReturn(unsignedDeleteAccountTxProgram(lucid, config));

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
export const distributePayout = (lucid: LucidEvolution, config: DistributePayoutConfig) =>
    makeReturn(unsignedDistributePayoutTxProgram(lucid, config));

/**
 * Withdraws a member's accumulated balance from the Treasury.
 */
export const memberWithdraw = (lucid: LucidEvolution, config: MemberWithdrawConfig) =>
    makeReturn(unsignedMemberWithdrawTxProgram(lucid, config));

/**
 * Exits a member from a DCU Group, claiming refunds or paying penalties.
 */
export const exitGroup = (lucid: LucidEvolution, config: ExitGroupConfig) =>
    makeReturn(unsignedExitGroupTxProgram(lucid, config));

/**
 * Terminates a group, burning the treasury membership token.
 */
export const terminateGroup = (lucid: LucidEvolution, config: TerminateGroupConfig) =>
    makeReturn(unsignedTerminateGroupTxProgram(lucid, config));
