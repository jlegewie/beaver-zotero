import { atom } from 'jotai/vanilla';
import { ExternalReference, authorCreators, authorLastNames } from '../types/externalReferences';
import { ZoteroItemReference } from '../types/zotero';
import { logger } from '../platform/logger';
import { combineSnapshots, ingestSnapshot, type SnapshotsBySource } from './externalRecords';
import { primaryExternalUrl } from './externalRecordDisplay';

/**
 * External-reference mapping state: the client-agnostic half of the external
 * reference cache.
 *
 * An "external reference" is a work or record found in an external source
 * (OpenAlex, PubMed, ClinicalTrials.gov, ...) that may or may not already
 * exist in the user's library. Two maps describe it, both keyed by `source_id`:
 *
 * - {@link externalReferenceMappingAtom} — the reference metadata itself, so a
 *   citation or source row can be rendered without re-fetching it. Each entry
 *   is the combination of the latest snapshot per source of that id.
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
 * Key is the source_id (e.g., OpenAlex W-id, pmid:N, NCT id). Each value is
 * the combined record of that id's snapshots; ingest through
 * {@link addExternalReferencesToMappingAtom}.
 */
export const externalReferenceMappingAtom = atom<Record<string, ExternalReference>>({});

/**
 * The snapshots behind {@link externalReferenceMappingAtom}: the latest
 * snapshot per source of each id. Only the ingest atom reads or writes it.
 */
const externalReferenceSnapshotsAtom = atom<Record<string, SnapshotsBySource>>({});

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
        set(externalReferenceSnapshotsAtom, {});
        set(externalReferenceItemMappingAtom, {});
        set(checkingExternalReferencesAtom, new Set());
        logger('clearExternalReferenceCache: all mappings cleared', 1);
    }
);

/**
 * Ingest external reference snapshots: a tool view's `references` and its
 * `extra_snapshots`, or records restored from history.
 *
 * Keeps the latest snapshot per source of each id (a timestamped snapshot
 * beats an untimestamped one, a strictly newer one wins, an equal one keeps
 * the stored snapshot, and between untimestamped ones the later arrival wins)
 * and recomputes the combined record of every id that changed. A newer
 * library check survives whichever snapshot carried it.
 */
export const addExternalReferencesToMappingAtom = atom(
    null,
    (get, set, references: ExternalReference[]) => {
        if (!references || references.length === 0) return;

        const snapshots = { ...get(externalReferenceSnapshotsAtom) };
        const changed = new Set<string>();
        for (const ref of references) {
            const sourceId = ref?.source_id;
            if (!sourceId) continue;
            const updated = ingestSnapshot(snapshots[sourceId], ref);
            if (!updated) continue;
            snapshots[sourceId] = updated;
            changed.add(sourceId);
        }
        if (changed.size === 0) return;

        const mapping = { ...get(externalReferenceMappingAtom) };
        for (const sourceId of changed) {
            mapping[sourceId] = combineSnapshots(Object.values(snapshots[sourceId]));
        }
        set(externalReferenceSnapshotsAtom, snapshots);
        set(externalReferenceMappingAtom, mapping);
        logger(`addExternalReferencesToMapping: Ingested ${references.length} snapshots (${changed.size} ids changed)`, 1);
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
 * Format the compact label used when an external work is cited inline.
 *
 * External citations embedded in agent-action arguments can be rendered before
 * the run's resolved citation metadata arrives. The external-reference record
 * is already available at that point, so keep the fallback here rather than
 * requiring every renderer to reconstruct an author/year label independently.
 */
export function formatExternalReferenceLabel(ref: ExternalReference): string {
    const lastNames = authorLastNames(ref);
    const author = lastNames.length
        ? `${lastNames[0]}${lastNames.length > 1 ? ' et al.' : ''}`
        : '';
    const year = ref.year != null
        ? String(ref.year)
        : ref.publication_date?.match(/^\d{4}/)?.[0] ?? '';

    if (author && year) return `${author}, ${year}`;
    return author || year || ref.title || ref.source_id || '';
}

/** Pick the most useful stable link available for an external work. */
export function getExternalReferenceUrl(ref: ExternalReference): string | undefined {
    return primaryExternalUrl(ref);
}

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

    // Authors: author-role creators when the record has them (organizations
    // kept whole), otherwise parsed from the display names.
    const creators = authorCreators(ref);
    const names: string[] = creators
        ? creators.map((creator, index) => creator.lastName
            ? (index === 0
                ? [creator.lastName, creator.firstName].filter(Boolean).join(', ')
                : [creator.firstName, creator.lastName].filter(Boolean).join(' '))
            : (creator.name ?? '').trim())
        : (ref.authors ?? []).map((author, index) => formatAuthorName(author, index === 0));
    const authors = names.filter((name) => !!name);
    if (authors.length > 0) {
        let authorStr: string;

        if (authors.length > 3) {
            // More than 3 authors: first author + et al.
            authorStr = authors[0] + ' et al.';
        } else if (authors.length === 1) {
            authorStr = authors[0];
        } else {
            // 2-3 authors: "lastName, firstName, firstName lastName and firstName lastName"
            const lastAuthor = authors[authors.length - 1];
            authorStr = authors.slice(0, -1).join(', ') + ' and ' + lastAuthor;
        }

        parts.push(authorStr.endsWith('.') ? authorStr : authorStr + '.');
    }

    // Year
    const year = ref.year ?? ref.publication_date?.match(/^\d{4}/)?.[0];
    if (year) {
        parts.push(`${year}.`);
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
