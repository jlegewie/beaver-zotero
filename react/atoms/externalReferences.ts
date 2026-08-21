import { atom } from 'jotai';
import { ExternalReference, extractAuthorLastName } from '@beaver/agent-core/types/externalReferences';
import { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { findExistingReference, FindReferenceData } from '../utils/findExistingReference';
import { logger } from '@beaver/agent-core/platform/logger';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';
import { libraryRefForLibraryID, modelObjectIdFromReference, resolveItemReference, resolveLibraryRef } from '../../src/utils/libraryIdentity';
import {
    checkingExternalReferencesAtom,
    externalReferenceItemMappingAtom,
} from '@beaver/agent-core/citations/externalReferences';

/**
 * Zotero resolution for external references: the client-specific half of the
 * external reference cache.
 *
 * These atoms answer "does this searched-for work already exist in the user's
 * library?" by resolving portable item references and searching the library, then
 * write the answer into the shared mapping state in
 * `@beaver/agent-core/citations/externalReferences`. The mapping state, its
 * read-only derivations and the display formatter live there; only the lookups
 * that need Zotero live here.
 */

/**
 * Check if external reference exists in Zotero library
 * Uses cache first, validates backend data, falls back to findExistingReference
 *
 * Flow:
 * 1. Check cache - return if found
 * 2. Check backend data (library_items) - validate first item and cache
 * 3. Fall back to findExistingReference - search and cache
 *
 * Cache is keyed by source_id (e.g., Semantic Scholar ID, OpenAlex ID)
 */
export const checkExternalReferenceAtom = atom(
    null,
    async (get, set, externalRef: ExternalReference): Promise<ZoteroItemReference | null> => {
        const refId = externalRef.source_id; // Use source_id as the cache key
        if (!refId) {
            logger('checkExternalReference: No valid source_id found for external reference', 1);
            return null;
        }
        
        const cache = get(externalReferenceItemMappingAtom);
        const checking = get(checkingExternalReferencesAtom);
        
        // Check cache first
        if (refId in cache) {
            return cache[refId];
        }
        
        // Prevent duplicate checks
        if (checking.has(refId)) {
            // Wait briefly and check cache again
            await new Promise(resolve => setTimeout(resolve, 100));
            return get(externalReferenceItemMappingAtom)[refId] ?? null;
        }
        
        // Mark as checking
        set(checkingExternalReferencesAtom, new Set([...checking, refId]));
        
        try {
            let result: ZoteroItemReference | null = null;
            let foundItem: Zotero.Item | null = null;
            
            // First, validate backend data if library_items exist
            if (externalRef.library_items && externalRef.library_items.length > 0) {
                const firstItem = externalRef.library_items[0];
                logger(`checkExternalReference: Validating backend data for ${refId}`, 1);
                try {
                    // Resolve through library_ref when present: a numeric
                    // library_id written on another device is stale for group
                    // libraries, but the portable ref still maps to this
                    // device's local library. Unavailable libraries fall
                    // through to the search-based fallback below.
                    const resolved = await resolveItemReference(firstItem);
                    if (resolved.status === 'found' && !resolved.item.deleted) {
                        const item = resolved.item;
                        result = {
                            library_id: item.libraryID,
                            zotero_key: item.key,
                            library_ref: firstItem.library_ref ?? libraryRefForLibraryID(item.libraryID) ?? undefined,
                        };
                        foundItem = item;
                        logger(`checkExternalReference: Backend data validated for ${refId}`, 1);
                    } else if (resolved.status === 'library_unavailable') {
                        logger(`checkExternalReference: Library unavailable for ${refId}`, 1);
                    } else {
                        logger(`checkExternalReference: Backend data invalid for ${refId}, item not found`, 1);
                    }
                } catch (backendError) {
                    logger(`checkExternalReference: Backend validation failed for ${refId}: ${backendError}`, 2);
                }
            }
            
            // Fall back to findExistingReference if backend validation failed
            if (!result) {
                logger(`checkExternalReference: Searching for ${refId}`, 1);
                try {
                    const existingItem = await findExistingReference(1, {
                        title: externalRef.title,
                        date: externalRef.publication_date,
                        DOI: externalRef.identifiers?.doi,
                        ISBN: externalRef.identifiers?.isbn,
                        creators: externalRef.authors?.map(author => extractAuthorLastName(author))
                    } as FindReferenceData);

                    if (existingItem) {
                        result = {
                            library_id: existingItem.libraryID,
                            zotero_key: existingItem.key,
                            library_ref: libraryRefForLibraryID(existingItem.libraryID) ?? undefined,
                        };
                        foundItem = existingItem;
                        logger(`checkExternalReference: Found match for ${refId}: ${result.library_id}-${result.zotero_key}`, 1);
                    } else {
                        logger(`checkExternalReference: No match found for ${refId}`, 1);
                    }
                } catch (searchError) {
                    logger(`checkExternalReference: Search failed for ${refId}: ${searchError}`, 2);
                }
            }
            
            // Load full item data if found (needed for getBestAttachment and display)
            if (foundItem) {
                await loadFullItemDataWithAllTypes([foundItem]);
            }
            
            // Update cache (even on error, cache null to prevent repeated failed attempts)
            set(externalReferenceItemMappingAtom, {
                ...get(externalReferenceItemMappingAtom),
                [refId]: result
            });
            
            return result;
        } finally {
            // Remove from checking set - read latest value to avoid overwriting concurrent updates
            const currentChecking = new Set(get(checkingExternalReferencesAtom));
            currentChecking.delete(refId);
            set(checkingExternalReferencesAtom, currentChecking);
        }
    }
);


/**
 * Bulk check multiple external references at once
 * More efficient than checking one by one
 * Uses source_id as the cache key
 */
export const checkExternalReferencesAtom = atom(
    null,
    async (get, set, externalRefs: ExternalReference[]): Promise<void> => {
        logger(`checkExternalReferences: Checking ${externalRefs.length} external references`, 1);
        const cache = get(externalReferenceItemMappingAtom);
        const checking = get(checkingExternalReferencesAtom);
        
        // Filter out already cached or currently checking references
        const refsToCheck = externalRefs.filter(ref => {
            const refId = ref.source_id;
            return refId && !(refId in cache) && !checking.has(refId);
        });
        
        logger(`checkExternalReferences: After filtering, ${refsToCheck.length} refs to check (${externalRefs.length - refsToCheck.length} already cached/checking)`, 1);
        
        if (refsToCheck.length === 0) {
            return;
        }
        
        // Mark all as checking
        const newChecking = new Set(checking);
        refsToCheck.forEach(ref => {
            const refId = ref.source_id;
            if (refId) newChecking.add(refId);
        });
        set(checkingExternalReferencesAtom, newChecking);
        
        try {
            // Collect found items for batch data loading
            const foundItems: Zotero.Item[] = [];
            
            // Check all references in parallel, with individual error handling
            const results = await Promise.all(
                refsToCheck.map(async (ref): Promise<[string, ZoteroItemReference | null] | null> => {
                    const refId = ref.source_id;
                    if (!refId) return null;
                    
                    try {
                        let result: ZoteroItemReference | null = null;
                        
                        // Validate backend data first
                        if (ref.library_items && ref.library_items.length > 0) {
                            const libraryItems = ref.library_items.map(element => modelObjectIdFromReference(element));
                            logger(`checkExternalReferences: Checking ${refId} backend data (${libraryItems.join(', ')})`, 1);
                            const isPersonal = (element: typeof ref.library_items[number]) =>
                                resolveLibraryRef(element) === Zotero.Libraries.userLibraryID;
                            const mainLibraryItems = ref.library_items.filter(isPersonal);
                            const itemsToTry = mainLibraryItems.length > 0
                                ? [...mainLibraryItems, ...ref.library_items.filter(element => !isPersonal(element))]
                                : ref.library_items;
                            for (const itemRef of itemsToTry) {
                                try {
                                    // Resolve through library_ref when present: a
                                    // numeric library_id written on another device
                                    // is stale for group libraries. Unavailable
                                    // libraries skip to the next candidate.
                                    const resolved = await resolveItemReference(itemRef);
                                    if (resolved.status === 'found') {
                                        const item = resolved.item;
                                        result = {
                                            library_id: item.libraryID,
                                            zotero_key: item.key,
                                            library_ref: itemRef.library_ref ?? libraryRefForLibraryID(item.libraryID) ?? undefined,
                                        };
                                        foundItems.push(item);
                                        logger(`checkExternalReferences: Backend data validated for ${refId}: ${result.library_id}-${result.zotero_key}`, 1);
                                        break;
                                    }
                                } catch (backendError) {
                                    logger(`checkExternalReferences: Backend validation failed for ${refId} (${modelObjectIdFromReference(itemRef)}): ${backendError}`, 2);
                                }
                            }
                        }
                        
                        // Fall back to findExistingReference
                        if (!result) {
                            try {
                                logger(`checkExternalReferences: Searching for ${refId}`, { title: ref.title, date: ref.publication_date, DOI: ref.identifiers?.doi, ISBN: ref.identifiers?.isbn, creators: ref.authors?.map(author => extractAuthorLastName(author)) }, 1);
                                const existingItem = await findExistingReference(1, {
                                    title: ref.title,
                                    date: ref.publication_date,
                                    DOI: ref.identifiers?.doi,
                                    ISBN: ref.identifiers?.isbn,
                                    creators: ref.authors?.map(author => extractAuthorLastName(author))
                                } as FindReferenceData);
                                if (existingItem) {
                                    result = {
                                        library_id: existingItem.libraryID,
                                        zotero_key: existingItem.key,
                                        library_ref: libraryRefForLibraryID(existingItem.libraryID) ?? undefined,
                                    };
                                    foundItems.push(existingItem);
                                    logger(`checkExternalReferences: Found match for ${refId}: ${result.library_id}-${result.zotero_key}`, 1);
                                }
                            } catch (searchError) {
                                logger(`checkExternalReferences: Search failed for ${refId}: ${searchError}`, 2);
                            }
                        }
                        
                        return [refId, result];
                    } catch (error) {
                        // Catch any unexpected errors and return null for this reference
                        logger(`checkExternalReferences: Unexpected error for ${refId}: ${error}`, 2);
                        return [refId, null];
                    }
                })
            );
            
            // Load full item data for all found items (needed for getBestAttachment and display)
            if (foundItems.length > 0) {
                await loadFullItemDataWithAllTypes(foundItems);
            }
            
            // Update cache with all results (including failed ones as null)
            const updates = Object.fromEntries(results.filter((r): r is [string, ZoteroItemReference | null] => r !== null));
            set(externalReferenceItemMappingAtom, {
                ...get(externalReferenceItemMappingAtom),
                ...updates
            });
            
        } finally {
            // Remove all from checking set
            const finalChecking = new Set(get(checkingExternalReferencesAtom));
            refsToCheck.forEach(ref => {
                const refId = ref.source_id;
                if (refId) finalChecking.delete(refId);
            });
            set(checkingExternalReferencesAtom, finalChecking);
        }
    }
);

/**
 * Mark external reference as imported with its Zotero item details
 * Used after successfully importing a reference
 * Uses source_id as the cache key
 */
export const markExternalReferenceImportedAtom = atom(
    null,
    (get, set, sourceId: string, itemReference: ZoteroItemReference) => {
        const cache = get(externalReferenceItemMappingAtom);
        set(externalReferenceItemMappingAtom, {
            ...cache,
            [sourceId]: itemReference
        });
        logger(`markExternalReferenceImported: ${sourceId} -> ${itemReference.library_id}-${itemReference.zotero_key}`, 1);
    }
);

/**
 * Mark external reference as deleted (no longer exists in Zotero)
 * Sets cache to null so UI immediately updates to show Import button
 * Uses source_id as the cache key
 */
export const markExternalReferenceDeletedAtom = atom(
    null,
    (get, set, sourceId: string) => {
        const cache = get(externalReferenceItemMappingAtom);
        set(externalReferenceItemMappingAtom, {
            ...cache,
            [sourceId]: null
        });
        logger(`markExternalReferenceDeleted: ${sourceId} -> null`, 1);
    }
);

/**
 * Invalidate cache for specific external reference
 * Forces a recheck next time the reference is accessed
 * Uses source_id as the cache key
 */
export const invalidateExternalReferenceCacheAtom = atom(
    null,
    (get, set, sourceId: string) => {
        const cache = get(externalReferenceItemMappingAtom);
        const { [sourceId]: _, ...rest } = cache;
        set(externalReferenceItemMappingAtom, rest);
        logger(`invalidateExternalReferenceCache: ${sourceId}`, 1);
    }
);
