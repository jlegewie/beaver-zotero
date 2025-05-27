import { atom } from 'jotai';
import { threadMessagesAtom } from '../atoms/threads';
import { getCitationFromItem, getReferenceFromItem, getDisplayNameFromItem } from '../utils/sourceUtils';
import { createZoteroItemReference } from "../types/zotero";
import { createZoteroURI } from "../utils/zoteroURI";
import { logger } from '../../src/utils/logger';
import { AttachmentCitation } from '../types/attachments/uiTypes';

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
        logger(`updateAttachmentCitationsAtom: Starting with ${messages.length} messages`);

        // Extract all citation IDs from the message content
        const citationIds: string[] = [];
        const citationRegex = /<citation\s+(?:[^>]*?)id="([^"]+)"(?:[^>]*?)\s*(?:\/>|><\/citation>)/g;
        for (const message of messages) {
            if (message.role === 'assistant' && message.content !== null) {
                let match;
                while ((match = citationRegex.exec(message.content)) !== null) {
                    if (match[1] && !citationIds.includes(match[1])) {
                        citationIds.push(match[1]);
                    }
                }
            }
        }

        logger(`updateAttachmentCitationsAtom: Found ${citationIds.length} citation IDs (${citationIds.join(', ')})`);

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