/**
 * Utilities for executing and undoing bulk annotation agent actions.
 * Used by AgentActionView for post-run manual apply and undo.
 */

import { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import type {
    CreateHighlightAnnotationsResultData,
    CreateNoteAnnotationsResultData,
} from '@beaver/agent-core/types/agentActions/createAnnotations';
import { resolveItemReference } from '../../utils/libraryIdentity';
import { assertLibraryRefNotExcluded, unboundedExecutionContext } from '../agentDataProvider/actions/actionExecution';
import { applyCreateHighlightAnnotations } from '../agentDataProvider/actions/createHighlightAnnotations';
import { applyCreateNoteAnnotations } from '../agentDataProvider/actions/createNoteAnnotations';

/**
 * Apply a stored create_highlight_annotations action through the shared
 * executor. There is no drift check: new annotations overwrite nothing.
 */
export async function executeCreateHighlightAnnotationsAction(
    action: AgentAction,
): Promise<CreateHighlightAnnotationsResultData> {
    return applyCreateHighlightAnnotations(action.proposed_data, unboundedExecutionContext());
}

/**
 * Apply a stored create_note_annotations action through the shared executor.
 * There is no drift check: new annotations overwrite nothing.
 */
export async function executeCreateNoteAnnotationsAction(
    action: AgentAction,
): Promise<CreateNoteAnnotationsResultData> {
    return applyCreateNoteAnnotations(action.proposed_data, unboundedExecutionContext());
}

/**
 * Undo a bulk annotation action by deleting every created annotation.
 */
export async function undoCreateAnnotationsAction(action: AgentAction): Promise<void> {
    const created = action.result_data?.created;
    if (!Array.isArray(created) || created.length === 0) {
        logger(`undoCreateAnnotationsAction: No created annotations for action ${action.id}`, 1);
        return;
    }

    // A library can be excluded after the action was applied, so the boundary
    // is checked again before anything is deleted.
    for (const ref of created) assertLibraryRefNotExcluded(ref);
    for (const ref of created) {
        const resolved = await resolveItemReference(ref);
        if (resolved.status === 'library_unavailable') {
            logger(`undoCreateAnnotationsAction: Library unavailable for ${ref.library_ref || ref.library_id}-${ref.zotero_key}`, 1);
            continue;
        }
        if (resolved.status === 'found') {
            await resolved.item.eraseTx();
        }
    }
}
