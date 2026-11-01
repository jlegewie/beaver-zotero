import * as operations from '../../src/services/manualActions/importItemActions';
import { captureAttachmentCompletion } from '../runtime/attachmentCompletion';
import { captureWindowMutationOptions, runWindowOperation } from '../runtime/libraryMutation';
import { getContextWindow } from '../runtime/windowRuntime';
import { getLibraryViewCollection, getZoteroTargetContext } from './zoteroTargetContext';
export type { ImportBatchExecuteResult, ImportBatchUndoResult } from '../../src/services/manualActions/importItemActions';

type ExecuteOptions = NonNullable<Parameters<typeof operations.executeImportItemActions>[1]>;

/**
 * The UI context's target, for actions that name no library (citation imports):
 * the library being viewed and, in the library tab, the selected collection.
 */
async function withContextTarget(options: ExecuteOptions): Promise<ExecuteOptions> {
    const win = getContextWindow();
    const context = await getZoteroTargetContext(win);
    return {
        ...options,
        libraryId: options.libraryId ?? context.targetLibraryId ?? Zotero.Libraries.userLibraryID,
        collectionId: options.collectionId ?? getLibraryViewCollection(win)?.id ?? null,
    };
}

export async function executeImportItemActions(
    actions: Parameters<typeof operations.executeImportItemActions>[0],
    options: ExecuteOptions = {},
): ReturnType<typeof operations.executeImportItemActions> {
    const owner = captureWindowMutationOptions();
    const resolved = await withContextTarget({ ...options, onAttachmentResolved: captureAttachmentCompletion() });
    return runWindowOperation('executeImportItemActions', [actions, resolved], owner);
}

/**
 * Import an external record with no pending action (a result row's Import)
 * into the library and collection being viewed. The backend prepares the
 * proposal at this click; a failure rejects with a message to retry.
 */
export async function importExternalReference(
    externalId: string,
    options: ExecuteOptions & { provider?: string } = {},
): ReturnType<typeof operations.importExternalReference> {
    const owner = captureWindowMutationOptions();
    const resolved = await withContextTarget({ ...options, onAttachmentResolved: captureAttachmentCompletion() });
    return runWindowOperation('importExternalReference', [externalId, resolved], owner);
}

export function undoImportItemActions(...args: Parameters<typeof operations.undoImportItemActions>): ReturnType<typeof operations.undoImportItemActions> {
    return runWindowOperation('undoImportItemActions', args);
}

export function undoImportItemAction(...args: Parameters<typeof operations.undoImportItemAction>): ReturnType<typeof operations.undoImportItemAction> {
    return runWindowOperation('undoImportItemAction', args);
}
