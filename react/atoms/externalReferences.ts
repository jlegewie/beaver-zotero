import { atom } from 'jotai';
import { ExternalReference, extractAuthorLastName } from '../types/externalReferences';
import { ZoteroItemReference } from '../types/zotero';
import { findExistingReference, FindReferenceData } from '../utils/findExistingReference';
import { logger } from '../../src/utils/logger';

/**
 * Get unique identifier for an external reference
 * Uses semantic_scholar_id or openalex_id
 */
export function getExternalReferenceId(ref: ExternalReference): string {
    return ref.semantic_scholar_id || ref.openalex_id || '';
}

/**
 * Cache mapping external reference IDs to Zotero item references
 * Format: { externalRefId: ZoteroItemReference | null }
 * null indicates the reference was checked but doesn't exist in Zotero
 */
export const externalReferenceItemMappingAtom = atom<Record<string, ZoteroItemReference | null>>({});

/**
 * Atom tracking which external references are currently being checked
 * Used to prevent duplicate checks and show loading states
 */
export const checkingExternalReferencesAtom = atom<Set<string>>(new Set<string>());

/**
 * Check if external reference exists in Zotero library
 * Uses cache first, validates backend data, falls back to findExistingReference
 * 
 * Flow:
 * 1. Check cache - return if found
 * 2. Check backend data (item_exists + library_id + zotero_key) - validate and cache
 * 3. Fall back to findExistingReference - search and cache
 */
export const checkExternalReferenceAtom = atom(
    null,
    async (get, set, externalRef: ExternalReference): Promise<ZoteroItemReference | null> => {
        const refId = getExternalReferenceId(externalRef);
        if (!refId) {
            logger('checkExternalReference: No valid ID found for external reference', 1);
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
            
            // First, validate backend data if it claims the item exists
            if (externalRef.item_exists && externalRef.library_id && externalRef.zotero_key) {
                logger(`checkExternalReference: Validating backend data for ${refId}`, 1);
                const item = await Zotero.Items.getByLibraryAndKeyAsync(
                    externalRef.library_id,
                    externalRef.zotero_key
                );
                
                if (item) {
                    result = {
                        library_id: externalRef.library_id,
                        zotero_key: externalRef.zotero_key
                    };
                    logger(`checkExternalReference: Backend data validated for ${refId}`, 1);
                } else {
                    logger(`checkExternalReference: Backend data invalid for ${refId}, item not found`, 1);
                }
            }
            
            // Fall back to findExistingReference if backend validation failed
            if (!result) {
                logger(`checkExternalReference: Searching for ${refId}`, 1);
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
                        zotero_key: existingItem.key
                    };
                }

                if (result) {
                    logger(`checkExternalReference: Found match for ${refId}: ${result.library_id}-${result.zotero_key}`, 1);
                } else {
                    logger(`checkExternalReference: No match found for ${refId}`, 1);
                }
            }
            
            // Update cache
            set(externalReferenceItemMappingAtom, {
                ...cache,
                [refId]: result
            });
            
            return result;
        } finally {
            // Remove from checking set
            const newChecking = new Set(checking);
            newChecking.delete(refId);
            set(checkingExternalReferencesAtom, newChecking);
        }
    }
);


/**
 * Bulk check multiple external references at once
 * More efficient than checking one by one
 */
export const checkExternalReferencesAtom = atom(
    null,
    async (get, set, externalRefs: ExternalReference[]): Promise<void> => {
        const cache = get(externalReferenceItemMappingAtom);
        const checking = get(checkingExternalReferencesAtom);
        
        // Filter out already cached or currently checking references
        const refsToCheck = externalRefs.filter(ref => {
            const refId = getExternalReferenceId(ref);
            return refId && !(refId in cache) && !checking.has(refId);
        });
        
        if (refsToCheck.length === 0) {
            return;
        }
        
        // Mark all as checking
        const newChecking = new Set(checking);
        refsToCheck.forEach(ref => {
            const refId = getExternalReferenceId(ref);
            if (refId) newChecking.add(refId);
        });
        set(checkingExternalReferencesAtom, newChecking);
        
        try {
            // Check all references in parallel
            const results = await Promise.all(
                refsToCheck.map(async (ref): Promise<[string, ZoteroItemReference | null] | null> => {
                    const refId = getExternalReferenceId(ref);
                    if (!refId) return null;
                    
                    let result: ZoteroItemReference | null = null;
                    
                    // Validate backend data first
                    if (ref.item_exists && ref.library_id && ref.zotero_key) {
                        const item = await Zotero.Items.getByLibraryAndKeyAsync(
                            ref.library_id,
                            ref.zotero_key
                        );
                        
                        if (item) {
                            result = {
                                library_id: ref.library_id,
                                zotero_key: ref.zotero_key
                            };
                        }
                    }
                    
                    // Fall back to findExistingReference
                    if (!result) {
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
                                zotero_key: existingItem.key
                            };
                        }
                    }
                    
                    return [refId, result];
                })
            );
            
            // Update cache with all results
            const updates = Object.fromEntries(results.filter((r): r is [string, ZoteroItemReference | null] => r !== null));
            set(externalReferenceItemMappingAtom, {
                ...get(externalReferenceItemMappingAtom),
                ...updates
            });
            
        } finally {
            // Remove all from checking set
            const finalChecking = new Set(get(checkingExternalReferencesAtom));
            refsToCheck.forEach(ref => {
                const refId = getExternalReferenceId(ref);
                if (refId) finalChecking.delete(refId);
            });
            set(checkingExternalReferencesAtom, finalChecking);
        }
    }
);

/**
 * Mark external reference as imported with its Zotero item details
 * Used after successfully importing a reference
 */
export const markExternalReferenceImportedAtom = atom(
    null,
    (get, set, externalRefId: string, itemReference: ZoteroItemReference) => {
        const cache = get(externalReferenceItemMappingAtom);
        set(externalReferenceItemMappingAtom, {
            ...cache,
            [externalRefId]: itemReference
        });
        logger(`markExternalReferenceImported: ${externalRefId} -> ${itemReference.library_id}-${itemReference.zotero_key}`, 1);
    }
);

/**
 * Invalidate cache for specific external reference
 * Forces a recheck next time the reference is accessed
 */
export const invalidateExternalReferenceCacheAtom = atom(
    null,
    (get, set, externalRefId: string) => {
        const cache = get(externalReferenceItemMappingAtom);
        const { [externalRefId]: _, ...rest } = cache;
        set(externalReferenceItemMappingAtom, rest);
        logger(`invalidateExternalReferenceCache: ${externalRefId}`, 1);
    }
);

/**
 * Clear all cached mappings
 * Useful when switching users or resetting state
 */
export const clearExternalReferenceCacheAtom = atom(
    null,
    (get, set) => {
        set(externalReferenceItemMappingAtom, {});
        set(checkingExternalReferencesAtom, new Set());
        logger('clearExternalReferenceCache: all mappings cleared', 1);
    }
);

/**
 * Get cached reference for an external reference ID
 * Returns undefined if not cached, null if checked but not found, or ZoteroItemReference if found
 */
export const getCachedReferenceAtom = atom(
    (get) => (externalRefId: string): ZoteroItemReference | null | undefined => {
        const cache = get(externalReferenceItemMappingAtom);
        if (!(externalRefId in cache)) {
            return undefined; // Not cached
        }
        return cache[externalRefId]; // null or ZoteroItemReference
    }
);

/**
 * Get cached reference for an external reference object
 * Returns undefined if not cached, null if checked but not found, or ZoteroItemReference if found
 */
export const getCachedReferenceForObjectAtom = atom(
    (get) => (externalRef: ExternalReference): ZoteroItemReference | null | undefined => {
        const refId = getExternalReferenceId(externalRef);
        if (!refId) return undefined;
        
        const cache = get(externalReferenceItemMappingAtom);
        if (!(refId in cache)) {
            return undefined; // Not cached
        }
        return cache[refId]; // null or ZoteroItemReference
    }
);

/**
 * Check if an external reference is currently being checked
 */
export const isCheckingReferenceAtom = atom(
    (get) => (externalRefId: string): boolean => {
        return get(checkingExternalReferencesAtom).has(externalRefId);
    }
);

/**
 * Check if an external reference object is currently being checked
 */
export const isCheckingReferenceObjectAtom = atom(
    (get) => (externalRef: ExternalReference): boolean => {
        const refId = getExternalReferenceId(externalRef);
        if (!refId) return false;
        return get(checkingExternalReferencesAtom).has(refId);
    }
);

