import { atom } from "jotai";
import { Attachment, createAttachmentFromFile, createAttachmentFromZoteroItem, resolveZoteroItemAttachmentAsync } from "../types/attachments";

// Selected items
export const selectedItemsAtom = atom<Zotero.Item[]>([]);

// Pinned and removed attachments
export const pinnedItemsAtom = atom<Zotero.Item[]>([]);
export const removedItemKeysAtom = atom<string[]>([]);

// File attachments
export const localFilesAtom = atom<File[]>([]);


// "base" attachments with synchronous data (without the async fields resolved)
export const baseAttachmentsAtom = atom<Attachment[]>((get) => {
    const selectedItems = get(selectedItemsAtom);
    const pinnedItems = get(pinnedItemsAtom);
    const removedItemKeys = get(removedItemKeysAtom);
    const localFiles = get(localFilesAtom);

    // Filter out any items that appear in `removedItemKeys`
    const removedIDs = new Set(removedItemKeys);

    // For pinned or selected Zotero items, create a minimal "base" attachment
    const pinned = pinnedItems
        .filter((itm) => !removedIDs.has(itm.key))
        .map((itm) => createAttachmentFromZoteroItem(itm, /*pinned*/ true));

    const selected = selectedItems
        .filter((itm) => !removedIDs.has(itm.key))
        .map((itm) => createAttachmentFromZoteroItem(itm, /*pinned*/ false));

    // For local files, create a base "file" attachment
    const local = localFiles.map((f) => createAttachmentFromFile(f));

    // Merge them into a single array
    return [...pinned, ...selected, ...local].sort((a, b) => a.timestamp - b.timestamp);
});

// store a mapping from attachment.id => partial fields
export const resolvedFieldsAtom = atom<Record<string, Partial<Attachment>>>({});


// Re-runs every time baseAttachmentsAtom changes
export const resolveAttachmentsEffectAtom = atom(
    // READ function: read "baseAttachmentsAtom" so changes re-trigger the effect
    (get) => {
        const baseList = get(baseAttachmentsAtom);
        return baseList.map((a) => a.id).join(",");
    },

    // WRITE function: do async fetch for each attachment
    async (get, set) => {
        const baseList = get(baseAttachmentsAtom);
        const resolvedMap = get(resolvedFieldsAtom);

        for (const base of baseList) {
            // If we already have resolved data for this attachment, skip
            if (resolvedMap[base.id]?.valid !== undefined) {
                continue;
            }

            if (base.type === "zotero_item") {
                // We want to re-fetch the "full" version
                // from the existing createAttachmentFromZoteroItem
                try {
                    // This is your original async function
                    const resolvedData = await resolveZoteroItemAttachmentAsync(base.item);

                    // Update the record in resolvedFieldsAtom
                    set(resolvedFieldsAtom, (prev) => ({
                        ...prev,
                        [base.id]: resolvedData
                    }));
                } catch (err) {
                    console.error("Failed to resolve Zotero item:", err);
                }
            } else if (base.type === "file") {
                // Any async checks for file attachments
            } else if (base.type === "remote_file") {
                // Any async checks for remote file attachments
            }
        }
    }
);

// Derived atom that combines base attachments with resolved fields
export const currentAttachmentsAtom = atom((get) => {
    get(resolveAttachmentsEffectAtom);
    // get(resolveAttachmentsEffectAtom);

    const baseList = get(baseAttachmentsAtom);
    const resolvedMap = get(resolvedFieldsAtom);

    // Merge them
    return baseList.map((base) => {
        const resolved = resolvedMap[base.id] || {};
        return { ...base, ...resolved };
    });
});
