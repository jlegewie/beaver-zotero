import { atom } from 'jotai';
import { getDisplayNameFromItem, getReferenceFromItem } from '../utils/sourceUtils';
import { createZoteroURI } from "../utils/zoteroURI";
import { logger } from '../../src/utils/logger';
import { CitationMetadata, CitationData } from '../types/citations';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';


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
 * Get citation data by citation_id with O(1) lookup
 */
export const getCitationDataAtom = atom(
    (get) => (citationId: string): CitationData | undefined => {
        return get(citationDataMapAtom)[citationId];
    }
);

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
        const newCitationDataMap: Record<string, CitationData> = {};
        const citationKeyToNumeric = new Map<string, string>();
        logger(`updateCitationDataAtom: Computing ${metadata.length} citations`);

        // Extend the citation metadata with the attachment citation data
        for (const citation of metadata) {
            const citationKey = `${citation.library_id}-${citation.zotero_key}`;
            const prevCitation = prevMap[citation.citation_id];

            // Get or assign numeric citation for this citationKey
            if (!citationKeyToNumeric.has(citationKey)) {
                citationKeyToNumeric.set(citationKey, (citationKeyToNumeric.size + 1).toString());
            }
            const numericCitation = citationKeyToNumeric.get(citationKey)!;

            // Use existing extended metadata if available
            if (prevCitation) {
                newCitationDataMap[citation.citation_id] = { ...prevCitation, ...citation };
                continue;
            }

            logger(`updateCitationDataAtom: Computing citation ${citation.author_year} (${citation.citation_id})`);

            // Compute new extended metadata
            try {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(citation.library_id, citation.zotero_key);
                if (!item) throw new Error(`Item not found for citation ${citation.citation_id}`);
                await loadFullItemDataWithAllTypes([item]);

                const parentItem = item.parentItem;
                const itemToCite = item.isNote() ? item : parentItem || item;
                
                newCitationDataMap[citation.citation_id] = {
                    ...citation,
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
