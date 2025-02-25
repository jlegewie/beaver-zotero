import { atom } from "jotai";
import { Resource, ZoteroResource } from "../types/resources";
import { createZoteroResource, createFileResource } from "../utils/resourceUtils";
import { threadResourceKeysAtom } from "./messages";

/**
* Cache to track removed item keys to prevent them from reappearing
*/
export const removedItemKeysCache: Set<string> = new Set();

/**
* Atom to store the resources
*/
export const resourcesAtom = atom<Resource[]>([]);

/**
* Atom to reset all resources
*/
export const resetResourcesAtom = atom(
    null,
    (_, set) => {
        removedItemKeysCache.clear();
        set(resourcesAtom, []);
    }
);

/**
* Update resources based on Zotero items
*/
export const updateResourcesFromZoteroItemsAtom = atom(
    null,
    async (get, set, selectedItems: Zotero.Item[]) => {
        const currentResources = get(resourcesAtom);
        const threadResourceKeys = get(threadResourceKeysAtom);
        
        // Map of existing Zotero resources by item key
        const existingMap = new Map(
            currentResources
            .filter((res): res is ZoteroResource => res.type === 'zotero_item')
            .map((res) => [res.itemKey, res])
        );
        
        // Pinned resources
        const pinnedResources = currentResources
            .filter((res): res is ZoteroResource => res.type === 'zotero_item' && res.pinned);
    
        // Excluded keys
        const excludedKeys = new Set([
            ...removedItemKeysCache,
            ...threadResourceKeys,
            ...pinnedResources.map((res) => res.itemKey)
        ]);
    
        // Create new resources from selected items
        const newResourcesPromises = selectedItems
            .filter((item) => !excludedKeys.has(item.key))
            .map(async (item) => {
                if (existingMap.has(item.key)) {
                    return existingMap.get(item.key)!;
                }
                return await createZoteroResource(item, false);
            });
        
        // Wait for all resources to be created
        const newItemResources = await Promise.all(newResourcesPromises);
        
        // Combine with pinned resources
        const newResources = [
            ...pinnedResources,
            ...newItemResources
        ];
    
        // Combine with non-Zotero resources
        const nonZoteroResources = currentResources.filter((res) => res.type !== 'zotero_item');
    
        // Update state: merge and sort by timestamp
        set(
            resourcesAtom,
            [...newResources, ...nonZoteroResources].sort((a, b) => a.timestamp - b.timestamp)
        );
    }
);

/**
* Update resources based on Zotero selection
*/
export const updateResourcesFromZoteroSelectionAtom = atom(
    null,
    async (get, set) => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        await set(updateResourcesFromZoteroItemsAtom, items);
    }
);

/**
* Add a file resource
*/
export const addFileResourceAtom = atom(
    null,
    (get, set, file: File) => {
        const currentResources = get(resourcesAtom);
        // Use file.name as a unique identifier for files
        const exists = currentResources.find(
            (res) => res.type === 'file' && (res as any).filePath === file.name
        );
        if (!exists) {
            set(resourcesAtom, [...currentResources, createFileResource(file)]);
        }
    }
);

/**
* Update child item keys of a ZoteroResource
*/
export const updateChildItemKeysAtom = atom(
    null,
    (get, set, params: { resourceId: string, childItemKeys: string[] }) => {
        const { resourceId, childItemKeys } = params;
        const currentResources = get(resourcesAtom);
        
        const updated = currentResources.map((res) => {
            if (res.id === resourceId && res.type === 'zotero_item') {
                return { ...res, childItemKeys };
            }
            return res;
        });
        
        set(resourcesAtom, updated);
    }
);

/**
* Remove a resource by id
*/
export const removeResourceAtom = atom(
    null,
    (get, set, resource: Resource) => {
        const currentResources = get(resourcesAtom);
        if (resource.type === 'zotero_item') {
            removedItemKeysCache.add((resource as ZoteroResource).itemKey);
        }
        set(
            resourcesAtom,
            currentResources.filter((res) => res.id !== resource.id)
        );
    }
);

/**
* Toggle the pinned state of a resource
*/
export const togglePinResourceAtom = atom(
    null,
    (get, set, resourceId: string) => {
        const currentResources = get(resourcesAtom);
        const updated = currentResources.map((res) =>
            res.id === resourceId ? { ...res, pinned: !res.pinned } : res
    );
    set(resourcesAtom, updated);
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



