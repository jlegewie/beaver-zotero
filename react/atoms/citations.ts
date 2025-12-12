import { atom } from 'jotai';
import { getDisplayNameFromItem, getReferenceFromItem } from '../utils/sourceUtils';
import { createZoteroURI } from "../utils/zoteroURI";
import { logger } from '../../src/utils/logger';
import { CitationMetadata, CitationData, isExternalCitation, getCitationKey } from '../types/citations';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';
import { externalReferenceMappingAtom, formatExternalCitation } from './externalReferences';

/**
 * Fallback citation cache for citations not in citationDataMapAtom
 * Keyed by "libraryID-itemKey" (cleanKey)
 */
export interface FallbackCitation {
    formatted_citation: string;
    citation: string;
    url: string;
}
export const fallbackCitationCacheAtom = atom<Record<string, FallbackCitation>>({});


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


/**
 * Normalize a raw tag string for consistent matching.
 * 
 * Performs the following normalizations:
 * 1. Extracts and sorts attributes alphabetically by name
 * 2. Removes extra whitespace
 * 3. Normalizes self-closing syntax (`/>` → `>`)
 * 
 * This ensures tags with different attribute orders or formatting match:
 * - `<citation id="1" att_id="2"/>` matches `<citation att_id="2" id="1">`
 * - `<citation  id="1" />` matches `<citation id="1">`
 * 
 * @param rawTag The raw tag string to normalize
 * @returns Normalized tag string with sorted attributes
 */
export function normalizeRawTag(rawTag: string): string {
    // Extract the tag name
    const tagNameMatch = rawTag.match(/<(\w+)/);
    if (!tagNameMatch) {
        // Not a valid tag, return trimmed
        return rawTag.trim();
    }
    const tagName = tagNameMatch[1];
    
    // Extract all attributes as [name, value] pairs
    const attrs: [string, string][] = [];
    const attrRegex = /(\w+)="([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(rawTag)) !== null) {
        attrs.push([match[1], match[2]]);
    }
    
    // Sort attributes alphabetically by name for consistent matching
    attrs.sort((a, b) => a[0].localeCompare(b[0]));
    
    // Reconstruct the tag with sorted attributes
    const attrStr = attrs.map(([name, value]) => `${name}="${value}"`).join(' ');
    return attrStr ? `<${tagName} ${attrStr}>` : `<${tagName}>`;
}

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
 * Citation data mapped by normalized raw_tag for matching.
 * 
 * This is the primary lookup mechanism for ZoteroCitation components:
 * - During streaming: citations in text match against this via raw_tag
 * - After metadata arrives: same raw_tag matches enriched CitationData
 */
export const citationDataByRawTagAtom = atom<Record<string, CitationData>>((get) => {
    const dataMap = get(citationDataMapAtom);
    const byRawTag: Record<string, CitationData> = {};
    
    for (const citation of Object.values(dataMap)) {
        if (citation.raw_tag) {
            // Normalize the key for consistent matching
            const normalizedKey = normalizeRawTag(citation.raw_tag);
            byRawTag[normalizedKey] = citation;
        }
    }
    
    return byRawTag;
});

/**
 * Get all citation data as an array (for components that need the full list)
 */
export const citationDataListAtom = atom(
    (get) => Object.values(get(citationDataMapAtom))
);

// Track the most recent async update so stale computations don't override newer data
let citationDataUpdateVersion = 0;

export const updateCitationDataAtom = atom(
    null,
    async (get, set) => {
        const updateVersion = ++citationDataUpdateVersion;
        const metadata = get(citationMetadataAtom);
        const prevMap = get(citationDataMapAtom);
        const externalReferenceMap = get(externalReferenceMappingAtom);
        const newCitationDataMap: Record<string, CitationData> = {};
        logger(`updateCitationDataAtom: Computing ${metadata.length} citations`);

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

        if (updateVersion !== citationDataUpdateVersion) {
            logger(`updateCitationDataAtom: Skipping stale update version ${updateVersion}`, 3);
            return;
        }

        logger(`updateCitationDataAtom: Setting citationDataMapAtom with ${Object.keys(newCitationDataMap).length} citations`);
        set(citationDataMapAtom, newCitationDataMap);
    }
);
