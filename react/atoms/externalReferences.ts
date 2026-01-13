import { atom } from 'jotai';
import { ExternalReference, extractAuthorLastName } from '../types/externalReferences';
import { ZoteroItemReference } from '../types/zotero';
import { findExistingReference, FindReferenceData } from '../utils/findExistingReference';
import { logger } from '../../src/utils/logger';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';

/**
 * Cache mapping external reference source IDs to ExternalReference objects
 * Format: { sourceId: ExternalReference }
 * Key is the source_id (e.g., Semantic Scholar ID, OpenAlex ID)
 */
export const externalReferenceMappingAtom = atom<Record<string, ExternalReference>>({});

/**
 * Cache mapping external reference source IDs to Zotero item references
 * Format: { sourceId: ZoteroItemReference | null }
 * Key is the source_id (e.g., Semantic Scholar ID, OpenAlex ID)
 * null indicates the reference was checked but doesn't exist in Zotero
 */
export const externalReferenceItemMappingAtom = atom<Record<string, ZoteroItemReference | null>>({});

/**
 * Atom tracking which external references are currently being checked
 * Used to prevent duplicate checks and show loading states
 * Keyed by source_id
 */
export const checkingExternalReferencesAtom = atom<Set<string>>(new Set<string>());

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
                    const item = await Zotero.Items.getByLibraryAndKeyAsync(
                        firstItem.library_id,
                        firstItem.zotero_key
                    );
                    
                    if (item && !item.deleted) {
                        result = {
                            library_id: firstItem.library_id,
                            zotero_key: firstItem.zotero_key
                        };
                        foundItem = item;
                        logger(`checkExternalReference: Backend data validated for ${refId}`, 1);
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
                            zotero_key: existingItem.key
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
                            const libraryItems = ref.library_items.map(element => `${element.library_id}-${element.zotero_key}`);
                            logger(`checkExternalReferences: Checking ${refId} backend data (${libraryItems.join(', ')})`, 1);
                            const mainLibraryItems = ref.library_items.filter(element => element.library_id === 1);
                            const itemsToTry = mainLibraryItems.length > 0
                                ? [...mainLibraryItems, ...ref.library_items.filter(element => element.library_id !== 1)]
                                : ref.library_items;
                            for (const itemRef of itemsToTry) {
                                try {
                                    const item = await Zotero.Items.getByLibraryAndKeyAsync(
                                        itemRef.library_id,
                                        itemRef.zotero_key
                                    );
                                    
                                    if (item) {
                                        result = {
                                            library_id: itemRef.library_id,
                                            zotero_key: itemRef.zotero_key
                                        };
                                        foundItems.push(item);
                                        logger(`checkExternalReferences: Backend data validated for ${refId}: ${result.library_id}-${result.zotero_key}`, 1);
                                        break;
                                    }
                                } catch (backendError) {
                                    logger(`checkExternalReferences: Backend validation failed for ${refId} (${itemRef.library_id}-${itemRef.zotero_key}): ${backendError}`, 2);
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
                                        zotero_key: existingItem.key
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

/**
 * Clear all cached mappings
 * Useful when switching users or resetting state
 */
export const clearExternalReferenceCacheAtom = atom(
    null,
    (get, set) => {
        set(externalReferenceMappingAtom, {});
        set(externalReferenceItemMappingAtom, {});
        set(checkingExternalReferencesAtom, new Set());
        logger('clearExternalReferenceCache: all mappings cleared', 1);
    }
);

/**
 * Add external references to the mapping cache
 * Used during streaming and when loading threads
 */
export const addExternalReferencesToMappingAtom = atom(
    null,
    (get, set, references: ExternalReference[]) => {
        if (!references || references.length === 0) return;
        
        const currentMapping = get(externalReferenceMappingAtom);
        const newMapping = { ...currentMapping };
        
        for (const ref of references) {
            const sourceId = ref.source_id;
            if (sourceId && !newMapping[sourceId]) {
                newMapping[sourceId] = ref;
            }
        }
        
        set(externalReferenceMappingAtom, newMapping);
        logger(`addExternalReferencesToMapping: Added ${references.length} references`, 1);
    }
);

/**
 * Get external reference from mapping by source ID
 */
export const getExternalReferenceAtom = atom(
    (get) => (sourceId: string): ExternalReference | undefined => {
        return get(externalReferenceMappingAtom)[sourceId];
    }
);

/**
 * Get cached reference for an external reference source ID
 * Returns undefined if not cached, null if checked but not found, or ZoteroItemReference if found
 * Uses source_id as the lookup key
 */
export const getCachedReferenceAtom = atom(
    (get) => (sourceId: string): ZoteroItemReference | null | undefined => {
        const cache = get(externalReferenceItemMappingAtom);
        if (!(sourceId in cache)) {
            return undefined; // Not cached
        }
        return cache[sourceId]; // null or ZoteroItemReference
    }
);

/**
 * Get cached reference for an external reference object
 * Returns undefined if not cached, null if checked but not found, or ZoteroItemReference if found
 * Uses source_id from the object as the lookup key
 */
export const getCachedReferenceForObjectAtom = atom(
    (get) => (externalRef: ExternalReference): ZoteroItemReference | null | undefined => {
        const refId = externalRef.source_id;
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
 * Uses source_id as the lookup key
 */
export const isCheckingReferenceAtom = atom(
    (get) => (sourceId: string): boolean => {
        return get(checkingExternalReferencesAtom).has(sourceId);
    }
);

/**
 * Check if an external reference object is currently being checked
 * Uses source_id from the object as the lookup key
 */
export const isCheckingReferenceObjectAtom = atom(
    (get) => (externalRef: ExternalReference): boolean => {
        const refId = externalRef.source_id;
        if (!refId) return false;
        return get(checkingExternalReferencesAtom).has(refId);
    }
);


/**
 * Format a single author name
 * @param author Author name string (may be "firstName lastName" or "lastName, firstName")
 * @param isFirst Whether this is the first author (formats as "lastName, firstName")
 * @returns Formatted author string
 */
function formatAuthorName(author: string, isFirst: boolean): string {
    const trimmed = author.trim();
    
    if (trimmed.includes(',')) {
        // Already in "lastName, firstName" format
        if (isFirst) {
            return trimmed;
        }
        // Convert to "firstName lastName" for subsequent authors
        const [lastName, firstName] = trimmed.split(',').map(s => s.trim());
        return firstName ? `${firstName} ${lastName}` : lastName;
    }
    
    // Author is in "firstName lastName" format
    const nameParts = trimmed.split(/\s+/);
    if (nameParts.length === 1) {
        return trimmed; // Single name, return as is
    }
    
    if (isFirst) {
        // Convert to "lastName, firstName" for first author
        const lastName = nameParts.pop();
        const firstName = nameParts.join(' ');
        return `${lastName}, ${firstName}`;
    }
    
    return trimmed; // Keep as "firstName lastName" for subsequent authors
}

/**
 * Format a bibliographic citation string for external references
 * Format: Authors. Year. "Title." Journal/Venue.
 * 
 * Author rules:
 * - First author: lastName, firstName
 * - Subsequent authors: firstName lastName
 * - Separated by ", " with " and " before the last author
 * - More than 3 authors: first author et al.
 * 
 * Journal format: journalName volume: pages
 */
export function formatExternalCitation(ref: ExternalReference): string {
    const parts: string[] = [];
    
    // Authors
    if (ref.authors && ref.authors.length > 0) {
        let authorStr: string;
        
        if (ref.authors.length > 3) {
            // More than 3 authors: first author + et al.
            authorStr = formatAuthorName(ref.authors[0], true) + ' et al.';
        } else if (ref.authors.length === 1) {
            authorStr = formatAuthorName(ref.authors[0], true);
        } else {
            // 2-3 authors: "lastName, firstName, firstName lastName and firstName lastName"
            const formattedAuthors = ref.authors.map((a, i) => formatAuthorName(a, i === 0));
            const lastAuthor = formattedAuthors.pop();
            authorStr = formattedAuthors.join(', ') + ' and ' + lastAuthor;
        }
        
        parts.push(authorStr + '.');
    }
    
    // Year
    if (ref.year) {
        parts.push(`${ref.year}.`);
    }
    
    // Title (in quotes)
    if (ref.title) {
        parts.push(`"${ref.title}."`);
    }
    
    // Venue/Journal
    if (ref.venue) {
        parts.push(ref.venue + '.');
    } else if (ref.journal?.name) {
        let journalPart = ref.journal.name;
        if (ref.journal.volume) {
            journalPart += ` ${ref.journal.volume}`;
        }
        if (ref.journal.pages) {
            journalPart += `: ${ref.journal.pages}`;
        }
        parts.push(journalPart + '.');
    }
    
    return parts.join(' ');
}
