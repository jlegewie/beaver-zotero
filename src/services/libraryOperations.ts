import { executeRequest } from './agentDataProvider/handleAgentActionExecuteRequest';
import type { OperationContext } from './agentDataProvider/operationContext';
import { hydrateOperationRendering } from './agentDataProvider/prepareOperationRendering';
import * as tables from './artifacts/tableStore';
import * as imports from './itemImport';
import { coordinateLibraryMutation, type MutationOptions } from './libraryMutations';
import * as createAnnotations from './manualActions/createAnnotationsActions';
import * as createCollection from './manualActions/createCollectionActions';
import * as createItem from './manualActions/createItemActions';
import * as createNote from './manualActions/createNoteActions';
import * as editAnnotations from './manualActions/editAnnotationsActions';
import * as editMetadata from './manualActions/editMetadataActions';
import * as editNote from './manualActions/editNoteActions';
import * as manageCollections from './manualActions/manageCollectionsActions';
import * as manageTags from './manualActions/manageTagsActions';
import * as organizeItems from './manualActions/organizeItemsActions';
import { savePreparedNote } from './savePreparedNote';

const operations = {
    executeRequest,
    savePreparedNote,
    createZoteroItem: imports.createZoteroItem,
    applyCreateItemData: imports.applyCreateItemData,
    deleteAddedItem: imports.deleteAddedItem,
    executeCreateItemAction: createItem.executeCreateItemAction,
    undoCreateItemAction: createItem.undoCreateItemAction,
    executeCreateItemActions: createItem.executeCreateItemActions,
    undoCreateItemActions: createItem.undoCreateItemActions,
    executeCreateNoteAction: createNote.executeCreateNoteAction,
    undoCreateNoteAction: createNote.undoCreateNoteAction,
    executeEditNoteAction: editNote.executeEditNoteAction,
    undoEditNoteAction: editNote.undoEditNoteAction,
    executeEditNoteBatchAction: editNote.executeEditNoteBatchAction,
    undoEditNoteBatchAction: editNote.undoEditNoteBatchAction,
    executeEditMetadataAction: editMetadata.executeEditMetadataAction,
    undoEditMetadataAction: editMetadata.undoEditMetadataAction,
    executeOrganizeItemsAction: organizeItems.executeOrganizeItemsAction,
    undoOrganizeItemsAction: organizeItems.undoOrganizeItemsAction,
    executeManageTagsAction: manageTags.executeManageTagsAction,
    undoManageTagsAction: manageTags.undoManageTagsAction,
    executeManageCollectionsAction: manageCollections.executeManageCollectionsAction,
    undoManageCollectionsAction: manageCollections.undoManageCollectionsAction,
    undoManageCollectionsActions: manageCollections.undoManageCollectionsActions,
    executeCreateCollectionAction: createCollection.executeCreateCollectionAction,
    undoCreateCollectionAction: createCollection.undoCreateCollectionAction,
    executeCreateHighlightAnnotationsAction: createAnnotations.executeCreateHighlightAnnotationsAction,
    executeCreateNoteAnnotationsAction: createAnnotations.executeCreateNoteAnnotationsAction,
    undoCreateAnnotationsAction: createAnnotations.undoCreateAnnotationsAction,
    executeEditAnnotationsAction: editAnnotations.executeEditAnnotationsAction,
    undoEditAnnotationsAction: editAnnotations.undoEditAnnotationsAction,
    table_createTable: tables.createTableUncoordinated,
    table_writeTable: tables.writeTableUncoordinated,
    table_editTable: tables.editTableUncoordinated,
    table_openTable: tables.openTableUncoordinated,
    table_restoreShadowVersion: tables.restoreShadowVersionUncoordinated,
    table_revertTable: tables.revertTableUncoordinated,
    table_trimTable: tables.trimTableUncoordinated,
    table_deleteTable: tables.deleteTableUncoordinated,
    table_restoreTable: tables.restoreTableUncoordinated
};

export type LibraryOperationMap = typeof operations;
export type LibraryOperationName = keyof LibraryOperationMap;

/** Constructed only by the plugin bootstrap: write callbacks never belong to a window. */
export class LibraryOperations {
    run<K extends LibraryOperationName>(
        name: K, args: Parameters<LibraryOperationMap[K]>, options?: MutationOptions,
    ): ReturnType<LibraryOperationMap[K]> {
        const ownedArgs: any[] = [...args];
        if (name === 'executeRequest') {
            ownedArgs[0] = { ...ownedArgs[0], operation: hydrateOperationRendering(ownedArgs[0].operation) };
        } else if (name === 'executeCreateNoteAction') {
            ownedArgs[2] = hydrateOperationRendering(ownedArgs[2] as OperationContext);
        } else if (name === 'executeEditNoteAction' || name === 'executeEditNoteBatchAction' || name === 'undoEditNoteAction') {
            ownedArgs[1] = hydrateOperationRendering(ownedArgs[1] as OperationContext);
        }
        return coordinateLibraryMutation(() => (operations[name] as (...values: any[]) => Promise<any>)(...ownedArgs), options) as ReturnType<LibraryOperationMap[K]>;
    }
}
