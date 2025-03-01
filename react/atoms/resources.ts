import { atom } from "jotai";
import { Source, ZoteroSource } from "../types/resources";
import { createZoteroSource, createFileSource } from "../utils/resourceUtils";

/**
* Atom to store the sources (current sources and thread sources)
*/
export const currentSourcesAtom = atom<Source[]>([]);
export const threadSourcesAtom = atom<Source[]>([]);

// Derived atom for thread source keys
export const threadSourceKeysAtom = atom((get) => {
    const sources = get(threadSourcesAtom);
    const keys = sources
        .filter((source): source is ZoteroSource => source.type === 'zotero_item')
        .map((source) => source.itemKey);
    return keys;
});

// Derived atom for thread source count
export const threadSourceCountAtom = atom((get) => {
    const sources = get(threadSourcesAtom);
    return sources.length;
});


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
    async (get, set, selectedItems: Zotero.Item[]) => {
        const currentSources = get(currentSourcesAtom);
        const threadSourceKeys = get(threadSourceKeysAtom);
        
        // Map of existing Zotero sources by item key
        const existingMap = new Map(
            currentSources
            .filter((res): res is ZoteroSource => res.type === 'zotero_item')
            .map((res) => [res.itemKey, res])
        );
        
        // Pinned sources
        const pinnedSources = currentSources
            .filter((res): res is ZoteroSource => res.type === 'zotero_item' && res.pinned);
    
        // Excluded keys
        const excludedKeys = new Set([
            ...removedItemKeysCache,
            ...threadSourceKeys,
            ...pinnedSources.map((res) => res.itemKey)
        ]);
    
        // Create new sources from selected items
        const newSourcesPromises = selectedItems
            .filter((item) => !excludedKeys.has(item.key))
            .map(async (item) => {
                if (existingMap.has(item.key)) {
                    return existingMap.get(item.key)!;
                }
                return await createZoteroSource(item, false);
            });
        
        // Wait for all sources to be created
        const newItemSources = await Promise.all(newSourcesPromises);
        
        // Combine with pinned sources
        const newSources = [
            ...pinnedSources,
            ...newItemSources
        ];
    
        // Combine with non-Zotero sources
        const nonZoteroSources = currentSources.filter((res) => res.type !== 'zotero_item');
    
        // Update state: merge and sort by timestamp
        set(
            currentSourcesAtom,
            [...newSources, ...nonZoteroSources].sort((a, b) => a.timestamp - b.timestamp)
        );
    }
);

/**
* Update sources based on Zotero selection
*/
export const updateSourcesFromZoteroSelectionAtom = atom(
    null,
    async (get, set) => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        await set(updateSourcesFromZoteroItemsAtom, items);
    }
);

/**
* Add a file source
*/
export const addFileSourceAtom = atom(
    null,
    (get, set, file: File) => {
        const currentSources = get(currentSourcesAtom);
        // Use file.name as a unique identifier for files
        const exists = currentSources.find(
            (res) => res.type === 'file' && (res as any).filePath === file.name
        );
        if (!exists) {
            set(currentSourcesAtom, [...currentSources, createFileSource(file)]);
        }
    }
);

/**
* Update child item keys of a ZoteroSource
*/
export const updateChildItemKeysAtom = atom(
    null,
    (get, set, params: { sourceId: string, childItemKeys: string[] }) => {
        const { sourceId, childItemKeys } = params;
        const currentSources = get(currentSourcesAtom);
        
        const updated = currentSources.map((res) => {
            if (res.id === sourceId && res.type === 'zotero_item') {
                return { ...res, childItemKeys };
            }
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
    (get, set, source: Source) => {
        const currentSources = get(currentSourcesAtom);
        if (source.type === 'zotero_item') {
            removedItemKeysCache.add((source as ZoteroSource).itemKey);
        }
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



