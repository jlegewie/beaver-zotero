/**
 * Utilities for executing and undoing create_collection agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */
import { assertLibraryWritable, recheckCollectionForUndo } from '../collections/collectionMutations';
import { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import { CreateCollectionResultData } from '@beaver/agent-core/types/agentActions/base';
import { resolveLibraryRef } from '../../utils/libraryIdentity';
import { unboundedExecutionContext } from '../agentDataProvider/actions/actionExecution';
import { applyCreateCollection } from '../agentDataProvider/actions/createCollection';

/**
 * Apply a stored create_collection action through the shared executor.
 * There is no drift check: a new collection overwrites nothing.
 */
export async function executeCreateCollectionAction(
    action: AgentAction
): Promise<CreateCollectionResultData> {
    return applyCreateCollection(action.proposed_data, unboundedExecutionContext());
}

/**
 * Undo a create_collection agent action by deleting the created collection.
 *
 * Refuses when the collection has subcollections. Zotero's
 * `collection.eraseTx()` cascades through all descendant collections (see
 * `Zotero.Collection.prototype._eraseData`), so erasing a collection that
 * later had other collections moved into it would also destroy those and
 * anything under them. Mirrors the existing subcollection guard in
 * `executeManageCollectionsAction` (manageCollectionsActions.ts).
 *
 * @param action The agent action to undo (must have been applied)
 */
export async function undoCreateCollectionAction(
    action: AgentAction
): Promise<void> {
    const resultData = action.result_data as CreateCollectionResultData | undefined;

    if (!resultData?.collection_key || (!resultData?.library_id && !resultData?.library_ref)) {
        throw new Error('No result data available for undo - collection was not created');
    }

    // Get the collection
    const libraryID = resolveLibraryRef({ library_ref: resultData.library_ref, library_id: resultData.library_id });
    if (!libraryID) {
        logger(`undoCreateCollectionAction: Library unavailable for ${resultData.library_ref || resultData.library_id}-${resultData.collection_key}`, 1);
        return;
    }

    assertLibraryWritable(libraryID);
    const collection = recheckCollectionForUndo(
        typeof resultData.collection_id === 'string' ? resultData.collection_id : resultData.collection_key,
        libraryID,
    )?.collection;

    if (!collection) {
        // Collection may have already been deleted manually
        logger(`undoCreateCollectionAction: Collection ${resultData.library_id}-${resultData.collection_key} not found, may have been deleted`, 1);
        return;
    }

    // Refuse if subcollections were moved in after creation — eraseTx would
    // cascade-delete them. Items are fine (eraseTx detaches, doesn't delete).
    if (collection.hasChildCollections(false)) {
        throw new Error('Collection contains subcollections.');
    }

    // Erase the collection (this will NOT delete items in the collection, just remove them from it)
    await collection.eraseTx();
    logger(`undoCreateCollectionAction: Deleted collection "${collection.name}" (${resultData.library_id}-${resultData.collection_key})`, 1);
}
