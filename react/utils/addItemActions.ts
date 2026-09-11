import * as itemImport from '../../src/services/itemImport';
import { getSelectedCollection } from '../../src/utils/zoteroSelection';
import { captureWindowMutationOptions, runWindowOperation } from '../runtime/libraryMutation';
import { getContextWindow } from '../runtime/windowRuntime';
import { emitAttachmentResolved } from './attachmentResolvedEvent';
import { getZoteroTargetContext } from './zoteroTargetContext';
export { stampBeaverProvenanceExtra } from '../../src/services/itemImport';
export type { ImportItemOptions } from '../../src/services/itemImport';

async function resolveOptions(options?: itemImport.ImportItemOptions): Promise<itemImport.ImportItemOptions> {
    if (options?.libraryId !== undefined) return { onAttachmentResolved: emitAttachmentResolved, ...options };
    const win = getContextWindow();
    const isReader = win?.Zotero_Tabs?.selectedType === 'reader';
    const selectedCollection = isReader ? undefined : getSelectedCollection(win?.ZoteroPane);
    const context = await getZoteroTargetContext(win);
    return {
        onAttachmentResolved: emitAttachmentResolved,
        ...options,
        libraryId: context.targetLibraryId ?? Zotero.Libraries.userLibraryID,
        collectionId: options?.collectionId ?? (isReader ? undefined : selectedCollection?.id ?? context.collectionToAddTo?.id),
    };
}

export async function createZoteroItem(reference: Parameters<typeof itemImport.createZoteroItem>[0], options?: itemImport.ImportItemOptions) {
    const owner = captureWindowMutationOptions();
    const resolved = await resolveOptions(options);
    return runWindowOperation('createZoteroItem', [reference, resolved], owner);
}

export async function applyCreateItemData(data: Parameters<typeof itemImport.applyCreateItemData>[0], options?: itemImport.ImportItemOptions) {
    const owner = captureWindowMutationOptions();
    const resolved = await resolveOptions(options);
    return runWindowOperation('applyCreateItemData', [data, resolved], owner);
}

export async function applyCreateItem(action: Parameters<typeof itemImport.applyCreateItem>[0]) {
    return applyCreateItemData(action.proposed_data);
}

export function deleteAddedItem(...args: Parameters<typeof itemImport.deleteAddedItem>) {
    return runWindowOperation('deleteAddedItem', args);
}
