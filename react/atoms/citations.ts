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
 * Citation metadata view for UI display
 *
 * citationDataAtom extends citation metadata for the current thread
 * with the attachment citation data used for UI display. The atom is updated by the setter
 * function updateCitationDataAtom, which is called on "citation_metadata"
 * and when loading previous threads.
 */
export const citationDataAtom = atom<CitationData[]>([]);

export const updateCitationDataAtom = atom(
    null,
    async (get, set) => {
        const metadata = get(citationMetadataAtom);
        const prev = get(citationDataAtom);
        const newCitationData: CitationData[] = [];
        const citationKeyToNumeric = new Map<string, string>();
        logger(`updateCitationDataAtom: Computing ${metadata.length} citations`);

        // Extend the citation metadata with the attachment citation data
        for (const citation of metadata) {
            const citationKey = `${citation.library_id}-${citation.zotero_key}`;
            const prevCitation = prev.find((c) => c.citation_id === citation.citation_id);

            // Get or assign numeric citation for this citationKey
            if (!citationKeyToNumeric.has(citationKey)) {
                citationKeyToNumeric.set(citationKey, (citationKeyToNumeric.size + 1).toString());
            }
            const numericCitation = citationKeyToNumeric.get(citationKey)!;

            // Use existing extended metadata if available
            if (prevCitation) {
                newCitationData.push({ ...prevCitation, ...citation });
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
                
                newCitationData.push({
                    ...citation,
                    parentKey: parentItem?.key || null,
                    icon: item.getItemTypeIconName(),
                    name: getDisplayNameFromItem(itemToCite),
                    citation: getDisplayNameFromItem(itemToCite),
                    formatted_citation: getReferenceFromItem(itemToCite),
                    url: createZoteroURI(item),
                    numericCitation
                });
            } catch (error) {
                logger(`updateCitationDataAtom: Error processing citation ${citation.citation_id}: ${error instanceof Error ? error.message : String(error)}`);
                newCitationData.push({
                    ...citation,
                    parentKey: null,
                    icon: null,
                    name: citation.author_year || null,
                    citation: citation.author_year || null,
                    formatted_citation: null,
                    url: null,
                    numericCitation
                });
            }
        }

        logger(`updateCitationDataAtom: Setting citationDataAtom with ${newCitationData.length} citations`);
        set(citationDataAtom, newCitationData);
    }
);