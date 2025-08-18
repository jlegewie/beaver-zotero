import { atom } from 'jotai';
import { threadMessagesAtom } from '../atoms/threads';
import { getCitationFromItem, getReferenceFromItem, getDisplayNameFromItem } from '../utils/sourceUtils';
import { createZoteroItemReference } from "../types/zotero";
import { createZoteroURI } from "../utils/zoteroURI";
import { logger } from '../../src/utils/logger';
import { AttachmentCitation } from '../types/attachments/uiTypes';
import { CitationMetadata, CitationData } from '../types/citations';


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
        logger(`updateCitationDataAtom: Computing ${metadata.length} citations`);

        // Extend the citation metadata with the attachment citation data
        for (const citation of metadata) {
            const prevCitation = prev.find((c) => c.citation_id === citation.citation_id);

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

                const parentItem = item.parentItem;
                const itemToCite = item.isNote() ? item : parentItem || item;
                
                newCitationData.push({
                    ...citation,
                    parentKey: parentItem?.key || null,
                    icon: item.getItemTypeIconName(),
                    name: getDisplayNameFromItem(itemToCite),
                    citation: getCitationFromItem(itemToCite),
                    formatted_citation: getReferenceFromItem(itemToCite),
                    url: createZoteroURI(item),
                    numericCitation: (newCitationData.length + 1).toString()
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
                    numericCitation: (newCitationData.length + 1).toString()
                });
            }
        }

        logger(`updateCitationDataAtom: Setting citationDataAtom with ${newCitationData.length} citations`);
        set(citationDataAtom, newCitationData);
    }
);


/*
 * Attachment citations
 *
 * attachmentCitationsAtom are all attachments cited in assistant messages
 * formated as AttachmentCitation objects. They are used to display the 
 * in-line citations and the source list in the assistant message footer.
 * 
 */
export const attachmentCitationsAtom = atom<AttachmentCitation[]>([]);

export const updateAttachmentCitationsAtom = atom(
    null,
    async (get, set) => {
        const messages = get(threadMessagesAtom);
        logger(`updateAttachmentCitationsAtom: Updating citations for ${messages.length} messages`);

        // Extract all citation IDs from the message content
        const citationIds: string[] = [];
        const citationRegex = /<citation\s+(?:[^>]*?)id="([^"]+)"(?:[^>]*?)\s*(?:\/>|><\/citation>)/g;
        for (const message of messages) {
            const content = message.content + (message.reasoning_content || '');
            if (message.role === 'assistant' && content !== null) {
                let match;
                while ((match = citationRegex.exec(content)) !== null) {
                    if (match[1] && !citationIds.includes(match[1])) {
                        citationIds.push(match[1]);
                    }
                }
            }
        }

        logger(`updateAttachmentCitationsAtom: Found ${citationIds.length} citation IDs (${citationIds.join(', ')})`);

        // If the citations haven't changed, don't update the attachment citations atom
        const existingCitationIds = get(attachmentCitationsAtom).map(cit => `${cit.library_id}-${cit.zotero_key}`);
        if (citationIds.every(id => existingCitationIds.includes(id))) {
            logger(`updateAttachmentCitationsAtom: No changes to citations`);
            return;
        }

        // Get all items
        const items = await Promise.all(citationIds
            .map((citationId) => createZoteroItemReference(citationId))
            .filter((itemRef) => itemRef !== null)
            .map(async (itemRef) => await Zotero.Items.getByLibraryAndKeyAsync(itemRef.library_id, itemRef.zotero_key))
        );

        logger(`updateAttachmentCitationsAtom: Found ${items.length} items for ${citationIds.length} citations`);

        // Create AttachmentCitation objects
        const citations: AttachmentCitation[] = [];
        items.forEach((item, index) => {
            if (!item) return;
            
            const parentItem = item.parentItem;
            const itemToCite = item.isNote() ? item : parentItem || item;
            
            if (itemToCite) {
                citations.push({
                    library_id: item.libraryID,
                    zotero_key: item.key,
                    type: "source",
                    include: "fulltext",
                    parentKey: parentItem?.key || null,
                    // Citation fields
                    citation: getCitationFromItem(itemToCite),
                    name: getDisplayNameFromItem(itemToCite),
                    formatted_citation: getReferenceFromItem(itemToCite),
                    url: createZoteroURI(item),
                    icon: item.getItemTypeIconName(),
                    numericCitation: (index + 1).toString()
                });
            }
        });

        logger(`updateAttachmentCitationsAtom: Setting attachmentCitationsAtom with ${citations.length} citations`);
        set(attachmentCitationsAtom, citations);
    }
);