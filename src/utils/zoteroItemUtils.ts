/**
 * React-free helpers for inspecting Zotero items.
 *
 * Kept in its own module so esbuild-side callers can use them without dragging
 * the rest of `zoteroUtils.ts`.
 *
 * Allowed imports: `./logger` and type-only references. Never value-import
 * from `react/*`.
 */

import { logger } from "./logger";

/**
 * Extract available details from a Zotero item for debugging/logging purposes.
 *
 * @param item - Zotero item or any object to extract details from
 * @returns String with available item details
 */
export const getItemDetailsForLogging = (item: any): string => {
    if (!item) return "item is null/undefined";
    const details: string[] = [];
    try {
        if (item.id !== undefined) details.push(`id=${item.id}`);
        if (item.key !== undefined) details.push(`key=${item.key}`);
        if (item.libraryID !== undefined) details.push(`libraryID=${item.libraryID}`);
        if (item.itemType !== undefined) details.push(`itemType=${item.itemType}`);
        if (item.itemTypeID !== undefined) details.push(`itemTypeID=${item.itemTypeID}`);
        if (item.version !== undefined) details.push(`version=${item.version}`);
        if (item.parentID !== undefined) details.push(`parentID=${item.parentID}`);
        if (item.parentKey !== undefined) details.push(`parentKey=${item.parentKey}`);
        if (item.deleted !== undefined) details.push(`deleted=${item.deleted}`);
        if (item.synced !== undefined) details.push(`synced=${item.synced}`);
        if (item.dateAdded !== undefined) details.push(`dateAdded=${item.dateAdded}`);
        if (item.dateModified !== undefined) details.push(`dateModified=${item.dateModified}`);
        const methods = ['isInTrash', 'isRegularItem', 'isAttachment', 'isNote', 'isAnnotation'];
        const availableMethods = methods.filter(m => typeof item[m] === 'function');
        const missingMethods = methods.filter(m => typeof item[m] !== 'function');
        if (availableMethods.length > 0) details.push(`availableMethods=[${availableMethods.join(',')}]`);
        if (missingMethods.length > 0) details.push(`missingMethods=[${missingMethods.join(',')}]`);
        if (item.constructor?.name) details.push(`constructor=${item.constructor.name}`);
    } catch (e) {
        details.push(`(error extracting details: ${e})`);
    }
    return details.length > 0 ? details.join(', ') : "no details available";
};

/**
 * Safely check if an item is in trash.
 *
 * Some edge cases (e.g., corrupted items) can cause `isInTrash` to be
 * missing or throw. This wrapper provides a safe way to check trash status.
 *
 * @param item Zotero item (or any object) to check
 * @returns true if in trash, false if not, null if unable to determine
 */
export const safeIsInTrash = (item: any): boolean | null => {
    if (!item || typeof item.isInTrash !== "function") {
        logger(`safeIsInTrash: isInTrash not found. Item details: ${getItemDetailsForLogging(item)}`, 2);
        return null;
    }

    try {
        return item.isInTrash();
    } catch (error: any) {
        logger(`safeIsInTrash: isInTrash threw error="${error?.message ?? error}". Item details: ${getItemDetailsForLogging(item)}`, 2);
        return null;
    }
};
