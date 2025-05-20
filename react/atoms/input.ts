import { atom } from "jotai";
import { InputSource } from "../types/sources";
import { createSourceFromItem } from "../utils/sourceUtils";
import { userAddedSourceKeysAtom } from "./threads";
import { getCurrentReader } from "../utils/readerUtils";
import { TextSelection } from '../types/attachments/apiTypes';
import { logger } from "../../src/utils/logger";
import { Annotation } from "../types/attachments/apiTypes";
import { getPref } from "../../src/utils/prefs";

const updateSourcesFromZoteroSelection = getPref("updateSourcesFromZoteroSelection");

/**
* Current user message and sources
*/
export const currentMessageContentAtom = atom<string>('');
export const currentSourcesAtom = atom<InputSource[]>([]);
export const currentReaderAttachmentAtom = atom<InputSource | null>(null);

/**
* Current reader attachment key
*/
export const currentReaderAttachmentKeyAtom = atom<string | null>((get) => {
    const source = get(currentReaderAttachmentAtom);
    return source?.itemKey || null;
});

/**
 * Current reader text selection
*/
export const readerTextSelectionAtom = atom<TextSelection | null>(null);

/**
* Cache to track removed item keys to prevent them from reappearing
*/
export const removedItemKeysCache: Set<string> = new Set();

/**
* Atom to reset all sources
*/
export const resetCurrentSourcesAtom = atom(
    null,
    (_, set) => {
        removedItemKeysCache.clear();
        set(currentSourcesAtom, []);
    }
);

/**
* Update sources based on Zotero items
*/
export const updateSourcesFromZoteroItemsAtom = atom(
    null,
    async (get, set, items: Zotero.Item[], pinned: boolean = false) => {
        const currentSources = get(currentSourcesAtom);
        const userAddedSourceKeys = get(userAddedSourceKeysAtom);
        
        // Map of existing Zotero sources by item key
        const existingMap = new Map(currentSources.map((res) => [res.itemKey, res]));
        
        // Pinned sources
        const pinnedSources = currentSources.filter((res) => res.pinned);
    
        // Excluded keys
        const excludedKeys = new Set([
            ...removedItemKeysCache,
            ...userAddedSourceKeys,
            ...pinnedSources.map((res) => res.itemKey)
        ]);
    
        // Create new sources from selected items
        const newSourcesPromises = items
            .filter((item) => !excludedKeys.has(item.key))
            .map(async (item) => {
                if (existingMap.has(item.key)) {
                    return existingMap.get(item.key)!;
                }
                return await createSourceFromItem(item, pinned, userAddedSourceKeys);
            });
        
        // Wait for all sources to be created
        const newItemSources = await Promise.all(newSourcesPromises);
        
        // Combine with pinned sources
        const newSources = [
            ...pinnedSources,
            ...newItemSources
        ];
        
        // Update state: merge and sort by timestamp
        set(
            currentSourcesAtom,
            newSources.sort((a, b) => a.timestamp - b.timestamp)
        );
    }
);

/**
* Update sources based on Zotero selection
*/
export const updateSourcesFromZoteroSelectionAtom = atom(
    null,
    async (get, set, pinned: boolean = false) => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        await set(updateSourcesFromZoteroItemsAtom, items, pinned);
    }
);

/**
* Update sources based on Zotero reader item
*/
export const updateReaderAttachmentAtom = atom(
    null,
    async (_, set, reader?: any) => {
        // also gets the current reader item (parent item)
        // Zotero.getActiveZoteroPane().getSelectedItems()
        // Get current reader
        reader = reader || getCurrentReader();
        if (!reader) {
            set(currentReaderAttachmentAtom, null);
            return;
        }
        // Get reader item
        const item = Zotero.Items.get(reader.itemID);
        if (item) {
            logger(`Updating reader attachment to ${item.key}`);
            set(currentReaderAttachmentAtom, await createSourceFromItem(item, false, [], "reader"));
            await set(updateSourcesFromZoteroItemsAtom, []);
        }
    }
);


/**
* Update child item keys of a Source
*/
export const updateSourceChildItemKeysAtom = atom(
    null,
    (get, set, params: { sourceId: string, childItemKeys: string[] }) => {
        const { sourceId, childItemKeys } = params;
        const currentSources = get(currentSourcesAtom);
        
        const updated = currentSources.map((res) => {
            if (res.id === sourceId) return { ...res, childItemKeys };
            return res;
        });
        
        set(currentSourcesAtom, updated);
    }
);

/**
* Remove a source by id
*/
export const removeSourceAtom = atom(
    null,
    (get, set, source: InputSource) => {
        const currentSources = get(currentSourcesAtom);
        if(updateSourcesFromZoteroSelection) removedItemKeysCache.add(source.itemKey);
        set(
            currentSourcesAtom,
            currentSources.filter((res) => res.id !== source.id)
        );
    }
);

/**
* Toggle the pinned state of a source
*/
export const togglePinSourceAtom = atom(
    null,
    (get, set, sourceId: string) => {
        const currentSources = get(currentSourcesAtom);
        const updated = currentSources.map((res) =>
            res.id === sourceId ? { ...res, pinned: !res.pinned } : res
    );
    set(currentSourcesAtom, updated);
}
);

// switch (true) {
//     case attachment.isNote():
//         return null;
//     case attachment.isPDFAttachment():
//     case attachment.isImageAttachment(): {
//         const attachmentState = await attachment.getBestAttachmentState();
//         if (!attachmentState.exists) return null;

//         return attachment;
//     }
//     case attachment.isVideoAttachment():
//     case attachment.isWebAttachment():
//     case attachment.isEmbeddedImageAttachment():
//     case attachment.isSnapshotAttachment():
//     case attachment.isEPUBAttachment():
//         return null;
//     default:
//         return null;
// }