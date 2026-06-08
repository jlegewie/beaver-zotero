import { logger } from '../../utils/logger';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
} from '../agentProtocol';
import { validateEditNoteAction } from './actions/editNote';
import { validateEditMetadataAction } from './actions/editMetadata';
import { validateOrganizeItemsAction } from './actions/organizeItems';
import { validateCreateNoteAction } from './actions/createNote';
import { validateManageTagsAction } from './actions/manageTags';
import { validateManageCollectionsAction } from './actions/manageCollections';
import { validateCreateCollectionAction } from './actions/createCollection';
import { validateCreateItemAction } from './actions/createItems';
import { validateCreateHighlightAnnotationsAction } from './actions/createHighlightAnnotations';
import { validateCreateNoteAnnotationsAction } from './actions/createNoteAnnotations';


/**
 * Handle agent_action_validate request from backend.
 * Validates that an action can be performed and returns the current value
 * for before/after tracking, plus the user's preference.
 */
export async function handleAgentActionValidateRequest(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    logger(`handleAgentActionValidateRequest: Validating ${request.action_type}`, 1);

    try {
        if (request.action_type === 'edit_metadata') {
            return await validateEditMetadataAction(request);
        }

        if (request.action_type === 'create_collection') {
            return await validateCreateCollectionAction(request);
        }

        if (request.action_type === 'organize_items') {
            return await validateOrganizeItemsAction(request);
        }

        if (request.action_type === 'create_item') {
            return await validateCreateItemAction(request);
        }

        if (request.action_type === 'edit_note') {
            return await validateEditNoteAction(request);
        }

        if (request.action_type === 'create_note') {
            return await validateCreateNoteAction(request);
        }

        if (request.action_type === 'create_highlight_annotations') {
            return await validateCreateHighlightAnnotationsAction(request);
        }

        if (request.action_type === 'create_note_annotations') {
            return await validateCreateNoteAnnotationsAction(request);
        }

        if (request.action_type === 'manage_tags') {
            return await validateManageTagsAction(request);
        }

        if (request.action_type === 'manage_collections') {
            return await validateManageCollectionsAction(request);
        }

        // Unsupported action type.
        // Note: confirm_extraction approvals are backend-managed and intentionally
        // not validated through this local deferred-tool preference flow.
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Unsupported action type: ${request.action_type}`,
            error_code: 'unsupported_action_type',
            preference: 'always_ask',
        };
    } catch (error) {
        logger(`handleAgentActionValidateRequest: Error: ${error}`, 1);
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: String(error),
            error_code: 'validation_failed',
            preference: 'always_ask',
        };
    }
}
