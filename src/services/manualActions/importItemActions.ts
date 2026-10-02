/**
 * Apply and undo for `import_item` actions from the UI (queued tool actions,
 * citation "Import" clicks, undo/redo). Runs in the plugin realm through
 * `addon.libraryOperations`.
 */

import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import type { ImportItemProposedData, ImportItemResultData } from '@beaver/agent-core/types/itemImport';
import type { AttachmentResolvedPayload } from '../attachmentResolved';
import { undoImportItem, writeImportItem } from '../itemImport/write';
import { runWithConcurrency } from './createItemActions';

const BATCH_CONCURRENCY_LIMIT = 3;

export interface ExecuteImportItemActionOptions {
    runId?: string;
    threadId?: string;
    onAttachmentResolved?: (payload: AttachmentResolvedPayload) => void;
    /** Target library from the UI context, for actions that name none (citation imports). */
    libraryId?: number;
    /** Selected collection from the UI context (citation imports). */
    collectionId?: number | null;
}

export interface ImportBatchExecuteResult {
    successes: Array<{ action: AgentAction; result: ImportItemResultData }>;
    failures: Array<{ action: AgentAction; error: string; errorDetails?: Record<string, any> }>;
}

export interface ImportBatchUndoResult {
    successes: string[];
    failures: Array<{ actionId: string; error: string; errorDetails?: Record<string, any> }>;
}

function namesLibrary(data: ImportItemProposedData): boolean {
    return !!data.library_ref || (typeof data.library_id === 'number' && data.library_id > 0);
}

/** Write one `import_item` action. Citation actions resolve here, at the click. */
export async function executeImportItemAction(action: AgentAction, opts: ExecuteImportItemActionOptions = {}): Promise<ImportItemResultData> {
    const data = action.proposed_data as ImportItemProposedData;
    return writeImportItem(data, {
        // The action's own library wins; the UI context applies only when it names none.
        libraryId: namesLibrary(data) ? undefined : opts.libraryId,
        collectionId: namesLibrary(data) ? null : opts.collectionId,
        actionId: action.id,
        runId: opts.runId ?? action.run_id,
        threadId: opts.threadId,
        onAttachmentResolved: opts.onAttachmentResolved,
    });
}

/** Erase the item an applied `import_item` action created. */
export async function undoImportItemAction(action: AgentAction): Promise<void> {
    await undoImportItem(action.result_data as ImportItemResultData | undefined);
}

function errorDetails(error: any): Record<string, any> {
    return {
        stack_trace: error?.stack || '',
        error_name: error?.name,
        ...(error?.code ? { error_code: error.code } : {}),
        ...(error?.details ? error.details : {}),
    };
}

export async function executeImportItemActions(actions: AgentAction[], opts: ExecuteImportItemActionOptions = {}): Promise<ImportBatchExecuteResult> {
    const result: ImportBatchExecuteResult = { successes: [], failures: [] };
    const outcomes = await runWithConcurrency(actions, async (action) => {
        try {
            return { ok: true as const, action, result: await executeImportItemAction(action, opts) };
        } catch (error: any) {
            logger(`executeImportItemActions: ${action.id} failed: ${error?.message ?? error}`, 1);
            return { ok: false as const, action, error: error?.message || 'Failed to create item', errorDetails: errorDetails(error) };
        }
    }, BATCH_CONCURRENCY_LIMIT);
    for (const outcome of outcomes) {
        if (outcome.ok) result.successes.push({ action: outcome.action, result: outcome.result });
        else result.failures.push({ action: outcome.action, error: outcome.error, errorDetails: outcome.errorDetails });
    }
    return result;
}

export async function undoImportItemActions(actions: AgentAction[]): Promise<ImportBatchUndoResult> {
    const result: ImportBatchUndoResult = { successes: [], failures: [] };
    const outcomes = await runWithConcurrency(actions, async (action) => {
        try {
            await undoImportItemAction(action);
            return { ok: true as const, actionId: action.id };
        } catch (error: any) {
            return { ok: false as const, actionId: action.id, error: error?.message || 'Failed to undo item creation', errorDetails: errorDetails(error) };
        }
    }, BATCH_CONCURRENCY_LIMIT);
    for (const outcome of outcomes) {
        if (outcome.ok) result.successes.push(outcome.actionId);
        else result.failures.push({ actionId: outcome.actionId, error: outcome.error, errorDetails: outcome.errorDetails });
    }
    return result;
}
