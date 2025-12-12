import { atom } from 'jotai';
import { getDisplayNameFromItem, getReferenceFromItem } from '../utils/sourceUtils';
import { createZoteroURI } from "../utils/zoteroURI";
import { logger } from '../../src/utils/logger';
import { CitationMetadata, CitationData, isExternalCitation, getCitationKey } from '../types/citations';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';
import { externalReferenceMappingAtom, formatExternalCitation } from './externalReferences';

/**
 * Thread-scoped citation marker assignment.
 * 
 * Maps citation keys to numeric markers (e.g., "1", "2", "3").
 * This ensures consistent markers across streaming and post-metadata states:
 * - Markers are assigned in render order during streaming (first appearance = "1")
 * - Same citation key always gets the same marker
 * - Resets when thread changes (via resetCitationMarkersAtom)
 */
export const citationKeyToMarkerAtom = atom<Record<string, string>>({});

/**
 * Get or assign a numeric marker for a citation key.
 * Returns the existing marker if already assigned, otherwise assigns the next number.
 */
export const getOrAssignCitationMarkerAtom = atom(
    null,
    (get, set, citationKey: string): string => {
        const current = get(citationKeyToMarkerAtom);
        if (current[citationKey]) {
            return current[citationKey];
        }
        // Assign next number based on how many unique citations we've seen
        const nextMarker = (Object.keys(current).length + 1).toString();
        set(citationKeyToMarkerAtom, { ...current, [citationKey]: nextMarker });
        return nextMarker;
    }
);

/**
 * Lookup a citation marker without assigning (read-only).
 * Returns undefined if the citation key hasn't been assigned a marker yet.
 */
export const getCitationMarkerAtom = atom(
    (get) => (citationKey: string): string | undefined => {
        return get(citationKeyToMarkerAtom)[citationKey];
    }
);

/**
 * Reset citation markers. Called when creating a new thread or loading an existing one.
 */
export const resetCitationMarkersAtom = atom(
    null,
    (_get, set) => {
        set(citationKeyToMarkerAtom, {});
    }
);


/*
 * Citation metadata
 *
 * citationMetadataAtom are all citations metadata for the current thread.
 * Populated by (a) "citation_metadata" events during streaming, and (b)
 * citations in message metadata.
 * 
 * They are used to display the citations in the assistant message footer.
 * 
 */
export const citationMetadataAtom = atom<CitationMetadata[]>([]);


/**
 * Citations by run ID
 *
 * citationsByRunIdAtom is a Record mapping run_id to CitationMetadata[].
 */
export const citationsByRunIdAtom = atom<Record<string, CitationMetadata[]>>(
    (get) => {
        const citations = get(citationMetadataAtom);
        const citationsByRunId: Record<string, CitationMetadata[]> = {};
        for (const citation of citations) {
            if (!citationsByRunId[citation.run_id]) {
                citationsByRunId[citation.run_id] = [];
            }
            citationsByRunId[citation.run_id].push(citation);
        }
        return citationsByRunId;
    }
);


/*
 * Citation data mapping for UI display
 *
 * citationDataMapAtom is a Record mapping citation_id to CitationData.
 * 
 * The atom is updated by updateCitationDataAtom, which is called on
 * "citation_metadata" events and when loading previous threads.
 */
export const citationDataMapAtom = atom<Record<string, CitationData>>({});

/**
 * Citation data mapped by citation key for lookup.
 * 
 * This is the primary lookup mechanism for ZoteroCitation components:
 * - MarkdownRenderer injects citation_key prop during preprocessing
 * - ZoteroCitation looks up metadata using this key
 * - Key is computed via getCitationKey() from library_id/zotero_key or external_source_id
 * 
 * Key format:
 * - Zotero citations: "zotero:{library_id}-{zotero_key}"
 * - External citations: "external:{external_source_id}"
 */
export const citationDataByCitationKeyAtom = atom<Record<string, CitationData>>((get) => {
    const dataMap = get(citationDataMapAtom);
    const byKey: Record<string, CitationData> = {};
    
    for (const citation of Object.values(dataMap)) {
        const key = getCitationKey({
            library_id: citation.library_id,
            zotero_key: citation.zotero_key,
            external_source_id: citation.external_source_id
        });
        if (key) {
            byKey[key] = citation;
        }
    }
    
    return byKey;
});

/**
 * Get all citation data as an array (for components that need the full list)
 */
export const citationDataListAtom = atom(
    (get) => Object.values(get(citationDataMapAtom))
);

/**
 * Tracks the current pending update promise for race condition handling.
 * This replaces the module-level version counter with a cleaner pattern.
 */
const pendingUpdateRef = { current: null as Promise<void> | null };

export const updateCitationDataAtom = atom(
    null,
    async (get, set) => {
        const metadata = get(citationMetadataAtom);
        const prevMap = get(citationDataMapAtom);
        const externalReferenceMap = get(externalReferenceMappingAtom);
        const newCitationDataMap: Record<string, CitationData> = {};
        logger(`updateCitationDataAtom: Computing ${metadata.length} citations`);
        
        // Create a unique reference for this update
        const thisUpdate = {} as Promise<void>;
        pendingUpdateRef.current = thisUpdate;

        // Extend the citation metadata with the attachment citation data
        for (const citation of metadata) {

            // Get unique key (works for both Zotero and external citations)
            // Uses getCitationKey to match key generation in ZoteroCitation component
            const citationKey = getCitationKey({
                library_id: citation.library_id,
                zotero_key: citation.zotero_key,
                external_source_id: citation.external_source_id
            });
            const prevCitation = prevMap[citation.citation_id];

            // Get or assign numeric citation using the shared thread-scoped atom.
            // This ensures markers assigned during streaming are preserved.
            const numericCitation = set(getOrAssignCitationMarkerAtom, citationKey);

            // Use existing extended metadata if available
            if (prevCitation) {
                newCitationDataMap[citation.citation_id] = { ...prevCitation, ...citation };
                continue;
            }

            logger(`updateCitationDataAtom: Computing citation ${citation.author_year} (${citation.citation_id})`);

            // Handle external citations differently
            if (isExternalCitation(citation)) {
                // Look up additional data from external reference mapping
                const externalRef = citation.external_source_id 
                    ? externalReferenceMap[citation.external_source_id] 
                    : undefined;

                // Preview for external references
                const externalFormattedCitation = externalRef ? formatExternalCitation(externalRef) : undefined;

                // For external citations, use the metadata directly
                newCitationDataMap[citation.citation_id] = {
                    ...citation,
                    type: "external",
                    parentKey: null,
                    icon: 'webpage-gray',  // Default icon for external references
                    name: citation.author_year || null,
                    citation: citation.author_year || null,
                    formatted_citation: externalFormattedCitation || null,
                    preview: citation.preview,
                    url: null, 
                    numericCitation
                };
                continue;
            }

            // Compute new extended metadata for Zotero citations
            try {
                if (!citation.library_id || !citation.zotero_key) {
                    throw new Error(`Missing library_id or zotero_key for citation ${citation.citation_id}`);
                }

                const item = await Zotero.Items.getByLibraryAndKeyAsync(citation.library_id, citation.zotero_key);
                if (!item) throw new Error(`Item not found for citation ${citation.citation_id}`);
                await loadFullItemDataWithAllTypes([item]);

                const parentItem = item.parentItem;
                const itemToCite = item.isNote() ? item : parentItem || item;
                
                newCitationDataMap[citation.citation_id] = {
                    ...citation,
                    type: item.isRegularItem() ? "item" : item.isAttachment() ? "attachment" : item.isNote() ? "note" : item.isAnnotation() ? "annotation" : "external",
                    parentKey: parentItem?.key || null,
                    icon: item.getItemTypeIconName(),
                    name: getDisplayNameFromItem(itemToCite),
                    citation: getDisplayNameFromItem(itemToCite),
                    formatted_citation: getReferenceFromItem(itemToCite),
                    url: createZoteroURI(item),
                    numericCitation
                };
            } catch (error) {
                logger(`updateCitationDataAtom: Error processing citation ${citation.citation_id}: ${error instanceof Error ? error.message : String(error)}`);
                newCitationDataMap[citation.citation_id] = {
                    ...citation,
                    type: "item",
                    parentKey: null,
                    icon: null,
                    name: citation.author_year || null,
                    citation: citation.author_year || null,
                    formatted_citation: null,
                    url: null,
                    numericCitation
                };
            }
        }

        // Check if this update is still the most recent one
        // If a newer update started, skip applying this stale result
        if (pendingUpdateRef.current !== thisUpdate) {
            logger(`updateCitationDataAtom: Skipping stale update`, 3);
            return;
        }

        logger(`updateCitationDataAtom: Setting citationDataMapAtom with ${Object.keys(newCitationDataMap).length} citations`);
        set(citationDataMapAtom, newCitationDataMap);
    }
);
