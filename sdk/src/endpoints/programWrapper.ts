
import { Effect } from "effect";
import { TxSignBuilder, LucidEvolution } from "@lucid-evolution/lucid";
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
export async function createGroup(
    lucid: LucidEvolution,
    config: CreateGroupConfig
): Promise<TxSignBuilder> {
    return Effect.runPromise(
        unsignedCreateGroupTxProgram(lucid, config)
    );
}

/**
 * Updates a DCU Group's parameters.
 */
export async function updateGroup(
    lucid: LucidEvolution,
    config: UpdateGroupConfig
): Promise<TxSignBuilder> {
    return Effect.runPromise(
        unsignedUpdateGroupTxProgram(lucid, config)
    );
}

/**
 * Deletes (deactivates) a DCU Group.
 */
export async function deleteGroup(
    lucid: LucidEvolution,
    config: DeleteGroupConfig
): Promise<TxSignBuilder> {
    return Effect.runPromise(
        unsignedDeleteGroupTxProgram(lucid, config)
    );
}

/**
 * Joins a user to a DCU Group.
 */
export async function joinGroup(
    lucid: LucidEvolution,
    config: JoinGroupConfig
): Promise<TxSignBuilder> {
    return Effect.runPromise(
        unsignedJoinGroupTxProgram(lucid, config)
    );
}

/**
 * Distributes payouts from a DCU Group Treasury to the assigned member.
 */
export async function distributePayout(
    lucid: LucidEvolution,
    config: DistributePayoutConfig
): Promise<TxSignBuilder> {
    return Effect.runPromise(
        unsignedDistributePayoutTxProgram(lucid, config)
    );
}

/**
 * Withdraws a member's accumulated balance from the Treasury.
 */
export async function memberWithdraw(
    lucid: LucidEvolution,
    config: MemberWithdrawConfig
): Promise<TxSignBuilder> {
    return Effect.runPromise(
        unsignedMemberWithdrawTxProgram(lucid, config)
    );
}

/**
 *Exits a member from a DCU Group, claiming refunds or paying penalties.
 */
export async function exitGroup(
    lucid: LucidEvolution,
    config: ExitGroupConfig
): Promise<TxSignBuilder> {
    return Effect.runPromise(
        unsignedExitGroupTxProgram(lucid, config)
    );
}

/**
 * Terminates a group, returning remaining treasury balance to admin.
 */
export async function terminateGroup(
    lucid: LucidEvolution,
    config: TerminateGroupConfig
): Promise<TxSignBuilder> {
    return Effect.runPromise(
        unsignedTerminateGroupTxProgram(lucid, config)
    );
}
