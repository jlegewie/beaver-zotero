/**
 * Tool-action registry: per-tool apply/undo dispatch for AgentActionView.
 *
 * Replaces the long `if (toolName === '...') ... else if (...)` chains in
 * `AgentActionView.tsx` with a `Record<AgentActionToolName, ToolActionHandler>`.
 * Each handler wraps an existing `execute*` / `undo*` utility and owns the
 * atom-setter calls (ack / error / undo / external-reference bookkeeping).
 *
 * Handler contract (preserves `AgentActionView`'s `isUndoError` state machine):
 *
 *  - Single-action `apply` and `undo` handlers **rethrow** on failure. The
 *    component's existing try/catch runs the catastrophic-fallback path
 *    (logs + bulk `setAgentActionsToError`, and for undo: `setIsUndoError(true)`
 *    → Retry button renders as "Retry Undo"). Do NOT swallow failures in these
 *    handlers.
 *  - Batch handlers (currently just `create_items`) handle partial failures
 *    internally: they call `ctx.setAgentActionsToError` per-failure and do NOT
 *    rethrow. This keeps `isUndoError=false` so Retry renders as "Try Again"
 *    (re-apply the errored items). A batch handler still rethrows on
 *    catastrophic failure (e.g., the underlying batch call itself throws).
 */

import { AgentAction } from '../agents/agentActions';
import type { AckActionLink } from '../../src/services/agentActionsService';
import type { ZoteroItemReference } from '../types/zotero';
import type { CreateItemProposedData } from '../types/agentActions/items';
import { executeEditMetadataAction, undoEditMetadataAction } from './editMetadataActions';
import { executeCreateCollectionAction, undoCreateCollectionAction } from './createCollectionActions';
import { executeOrganizeItemsAction, undoOrganizeItemsAction } from './organizeItemsActions';
import { executeCreateItemActions, undoCreateItemActions } from './createItemActions';
import { executeCreateNoteAction, undoCreateNoteAction } from './createNoteActions';
import { executeEditNoteAction, undoEditNoteAction } from './editNoteActions';
import { executeManageTagsAction, undoManageTagsAction } from './manageTagsActions';
import { executeManageCollectionsAction, undoManageCollectionsAction } from './manageCollectionsActions';
import { confirmOverwriteManualChanges } from '../components/agentRuns/agentActionViewHelpers';
import { logger } from '../../src/utils/logger';

export type AgentActionToolName =
    | 'edit_metadata'
    | 'create_collection'
    | 'organize_items'
    | 'manage_tags'
    | 'manage_collections'
    | 'create_note'
    | 'edit_note'
    | 'create_items';

export interface ToolActionContext {
    /** All actions for this toolcall (non-empty). For single-action tools, use actions[0]. */
    actions: AgentAction[];
    runId: string;
    ackAgentActions: (runId: string, actionResultData: AckActionLink[]) => Promise<unknown>;
    setAgentActionsToError: (actionIds: string[], errorMessage: string, errorDetails?: Record<string, any>) => void;
    undoAgentAction: (actionId: string) => void;
    markExternalReferenceImported: (sourceId: string, itemReference: ZoteroItemReference) => void;
    markExternalReferenceDeleted: (sourceId: string) => void;
}

export interface ToolActionHandler {
    apply(ctx: ToolActionContext): Promise<void>;
    undo(ctx: ToolActionContext): Promise<void>;
}

/**
 * Map legacy/alias tool names to their canonical registry key.
 * Returns null for tool names that AgentActionView does not dispatch.
 */
export function canonicalizeToolName(name: string): AgentActionToolName | null {
    if (name === 'create_item') return 'create_items';
    if (
        name === 'edit_metadata'
        || name === 'create_collection'
        || name === 'organize_items'
        || name === 'manage_tags'
        || name === 'manage_collections'
        || name === 'create_note'
        || name === 'edit_note'
        || name === 'create_items'
    ) {
        return name;
    }
    return null;
}

export function isAgentActionTool(name: string): name is AgentActionToolName {
    return canonicalizeToolName(name) !== null;
}

export const TOOL_ACTION_REGISTRY: Record<AgentActionToolName, ToolActionHandler> = {
    edit_metadata: {
        async apply(ctx) {
            const action = ctx.actions[0];
            const result = await executeEditMetadataAction(action);
            await ctx.ackAgentActions(ctx.runId, [{ action_id: action.id, result_data: result }]);
            logger(`AgentActionView: Applied edit_metadata action ${action.id}`, 1);
        },
        async undo(ctx) {
            const action = ctx.actions[0];
            let result = await undoEditMetadataAction(action, false);
            if (result.needsConfirmation && result.manuallyModified.length > 0) {
                const shouldOverwrite = confirmOverwriteManualChanges(result.manuallyModified);
                if (shouldOverwrite) {
                    result = await undoEditMetadataAction(action, true);
                    logger(`AgentActionView: Force-reverted ${result.fieldsReverted} fields after user confirmation`, 1);
                } else {
                    logger(`AgentActionView: User declined to overwrite ${result.manuallyModified.length} manually modified fields`, 1);
                }
            }
            if (result.alreadyReverted.length > 0) {
                logger(`AgentActionView: Fields already at original value: ${result.alreadyReverted.join(', ')}`, 1);
            }
            ctx.undoAgentAction(action.id);
            logger(`AgentActionView: Undone edit_metadata action ${action.id} (${result.fieldsReverted} fields reverted)`, 1);
        },
    },

    create_collection: {
        async apply(ctx) {
            const action = ctx.actions[0];
            const result = await executeCreateCollectionAction(action);
            await ctx.ackAgentActions(ctx.runId, [{ action_id: action.id, result_data: result }]);
            logger(`AgentActionView: Applied create_collection action ${action.id}`, 1);
        },
        async undo(ctx) {
            const action = ctx.actions[0];
            await undoCreateCollectionAction(action);
            ctx.undoAgentAction(action.id);
            logger(`AgentActionView: Undone create_collection action ${action.id}`, 1);
        },
    },

    organize_items: {
        async apply(ctx) {
            const action = ctx.actions[0];
            const result = await executeOrganizeItemsAction(action);
            await ctx.ackAgentActions(ctx.runId, [{ action_id: action.id, result_data: result }]);
            logger(`AgentActionView: Applied organize_items action ${action.id}`, 1);
        },
        async undo(ctx) {
            const action = ctx.actions[0];
            await undoOrganizeItemsAction(action);
            ctx.undoAgentAction(action.id);
            logger(`AgentActionView: Undone organize_items action ${action.id}`, 1);
        },
    },

    manage_tags: {
        async apply(ctx) {
            const action = ctx.actions[0];
            const result = await executeManageTagsAction(action);
            await ctx.ackAgentActions(ctx.runId, [{ action_id: action.id, result_data: result }]);
            logger(`AgentActionView: Applied manage_tags action ${action.id}`, 1);
        },
        async undo(ctx) {
            const action = ctx.actions[0];
            await undoManageTagsAction(action);
            ctx.undoAgentAction(action.id);
            logger(`AgentActionView: Undone manage_tags action ${action.id}`, 1);
        },
    },

    manage_collections: {
        async apply(ctx) {
            const action = ctx.actions[0];
            const result = await executeManageCollectionsAction(action);
            await ctx.ackAgentActions(ctx.runId, [{ action_id: action.id, result_data: result }]);
            logger(`AgentActionView: Applied manage_collections action ${action.id}`, 1);
        },
        async undo(ctx) {
            const action = ctx.actions[0];
            await undoManageCollectionsAction(action);
            ctx.undoAgentAction(action.id);
            logger(`AgentActionView: Undone manage_collections action ${action.id}`, 1);
        },
    },

    create_note: {
        async apply(ctx) {
            const action = ctx.actions[0];
            const result = await executeCreateNoteAction(action, ctx.runId);
            await ctx.ackAgentActions(ctx.runId, [{ action_id: action.id, result_data: result }]);
            logger(`AgentActionView: Applied create_note action ${action.id}`, 1);
        },
        async undo(ctx) {
            const action = ctx.actions[0];
            await undoCreateNoteAction(action);
            ctx.undoAgentAction(action.id);
            logger(`AgentActionView: Undone create_note action ${action.id}`, 1);
        },
    },

    edit_note: {
        // Callers (EditNoteGroupView, useEditNoteActions) dispatch one row at a
        // time, so this handler is single-action like edit_metadata. Preview
        // dismissal is the caller's responsibility: group-level callers dismiss
        // once before iterating, and reject-all also dismisses without going
        // through the registry — so keeping dismissal out of here keeps the
        // registry uniform.
        async apply(ctx) {
            const action = ctx.actions[0];
            const result = await executeEditNoteAction(action);
            await ctx.ackAgentActions(ctx.runId, [{ action_id: action.id, result_data: result }]);
            logger(`toolActionRegistry: Applied edit_note action ${action.id}`, 1);
        },
        async undo(ctx) {
            const action = ctx.actions[0];
            await undoEditNoteAction(action);
            ctx.undoAgentAction(action.id);
            logger(`toolActionRegistry: Undone edit_note action ${action.id}`, 1);
        },
    },

    create_items: {
        async apply(ctx) {
            const actionsToApply = ctx.actions.filter((candidate) => candidate.status !== 'applied');
            if (actionsToApply.length === 0) return;

            const batchResult = await executeCreateItemActions(actionsToApply);
            if (batchResult.successes.length > 0) {
                await ctx.ackAgentActions(ctx.runId, batchResult.successes.map((success) => ({
                    action_id: success.action.id,
                    result_data: success.result,
                })));
                logger(`AgentActionView: Applied ${batchResult.successes.length} create_item actions`, 1);

                for (const success of batchResult.successes) {
                    const proposedData = success.action.proposed_data as CreateItemProposedData;
                    if (proposedData?.item?.source_id) {
                        ctx.markExternalReferenceImported(proposedData.item.source_id, {
                            library_id: success.result.library_id,
                            zotero_key: success.result.zotero_key,
                        });
                    }
                }
            }

            if (batchResult.failures.length > 0) {
                for (const failure of batchResult.failures) {
                    ctx.setAgentActionsToError([failure.action.id], failure.error, failure.errorDetails);
                }
                logger(`AgentActionView: Failed to apply ${batchResult.failures.length} create_item actions`, 1);
            }
        },
        async undo(ctx) {
            const actionsToUndo = ctx.actions.filter((candidate) => candidate.status === 'applied');
            if (actionsToUndo.length === 0) return;

            const batchResult = await undoCreateItemActions(actionsToUndo);
            for (const actionId of batchResult.successes) {
                ctx.undoAgentAction(actionId);
                const undoneAction = actionsToUndo.find((candidate) => candidate.id === actionId);
                if (undoneAction) {
                    const proposedData = undoneAction.proposed_data as CreateItemProposedData;
                    if (proposedData?.item?.source_id) {
                        ctx.markExternalReferenceDeleted(proposedData.item.source_id);
                    }
                }
            }
            for (const failure of batchResult.failures) {
                ctx.setAgentActionsToError([failure.actionId], failure.error, failure.errorDetails);
            }
            logger(`AgentActionView: Undone ${batchResult.successes.length} create_item actions`, 1);
            if (batchResult.failures.length > 0) {
                logger(`AgentActionView: Failed to undo ${batchResult.failures.length} create_item actions`, 1);
            }
        },
    },
};
