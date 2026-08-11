import { atom } from 'jotai/vanilla';
import { ExternalReference } from '../types/externalReferences';
import { ZoteroItemReference } from '../types/zotero';
import { logger } from '../platform/logger';

/**
 * External-reference mapping state: the client-agnostic half of the external
 * reference cache.
 *
 * An "external reference" is a work found through a literature search
 * (Semantic Scholar, OpenAlex) that may or may not already exist in the user's
 * library. Two maps describe it, both keyed by `source_id`:
 *
 * - {@link externalReferenceMappingAtom} — the reference metadata itself, so a
 *   citation or source row can be rendered without re-fetching it.
 * - {@link externalReferenceItemMappingAtom} — which library item the reference
 *   resolves to, if any.
 *
 * Populating the second map requires searching the user's library, which is
 * inherently client-specific; that resolution half stays in the client (for the
 * Zotero plugin, `react/atoms/externalReferences.ts`) and writes back here. What
 * lives in this module is the state, its client-agnostic mutators, the read-only
 * derivations over it, and the display formatter — everything a shared render
 * component needs.
 */

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
