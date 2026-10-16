import * as operations from '../../src/services/manualActions/importItemActions';
import { getSelectedCollection } from '../../src/utils/zoteroSelection';
import { captureAttachmentCompletion } from '../runtime/attachmentCompletion';
import { captureWindowMutationOptions, runWindowOperation } from '../runtime/libraryMutation';
import { getContextWindow } from '../runtime/windowRuntime';
import { getZoteroTargetContext } from './zoteroTargetContext';
export type { ImportBatchExecuteResult, ImportBatchUndoResult } from '../../src/services/manualActions/importItemActions';

type ExecuteOptions = NonNullable<Parameters<typeof operations.executeImportItemActions>[1]>;

/**
 * The UI context's target, for actions that name no library (citation imports):
 * the library being viewed and, outside the reader, the selected collection.
 */
async function withContextTarget(options: ExecuteOptions): Promise<ExecuteOptions> {
    const win = getContextWindow();
    const isReader = win?.Zotero_Tabs?.selectedType === 'reader';
    const context = await getZoteroTargetContext(win);
    const selectedCollection = isReader ? undefined : getSelectedCollection(win?.ZoteroPane);
    return {
        ...options,
        libraryId: options.libraryId ?? context.targetLibraryId ?? Zotero.Libraries.userLibraryID,
        collectionId: options.collectionId ?? (isReader ? null : (selectedCollection?.id ?? context.collectionToAddTo?.id ?? null)),
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

export function undoImportItemActions(...args: Parameters<typeof operations.undoImportItemActions>): ReturnType<typeof operations.undoImportItemActions> {
    return runWindowOperation('undoImportItemActions', args);
}

export function undoImportItemAction(...args: Parameters<typeof operations.undoImportItemAction>): ReturnType<typeof operations.undoImportItemAction> {
    return runWindowOperation('undoImportItemAction', args);
}
