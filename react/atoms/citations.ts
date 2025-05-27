import { atom } from 'jotai';
import { threadMessagesAtom } from '../atoms/threads';
import { SourceCitation } from '../types/sources';
import { createSourceFromItemSync, getParentItem, getCitationFromItem, getReferenceFromItem, getDisplayNameFromItem } from '../utils/sourceUtils';
import { createZoteroItemReference } from "../types/zotero";
import { createZoteroURI } from "../utils/zoteroURI";
import { logger } from '../../src/utils/logger';

/*
 * Source citations
 *
 * sourceCitationsAtom are all sources cited in assistant messages
 * formated as SourceCitation objects. They are used to display the 
 * in-line citations and the source list in the assistant message footer.
 * 
 */
export const sourceCitationsAtom = atom<SourceCitation[]>([]);

export const updateSourceCitationsAtom = atom(
    null,
    async (get, set) => {
        const messages = get(threadMessagesAtom);
        logger(`updateSourceCitationsAtom: Starting with ${messages.length} messages`);

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

        logger(`updateSourceCitationsAtom: Found ${citationIds.length} citation IDs (${citationIds.join(', ')})`);

        // Get all items
        const items = await Promise.all(citationIds
            .map((citationId) => createZoteroItemReference(citationId))
            .filter((itemRef) => itemRef !== null)
            .map(async (itemRef) => await Zotero.Items.getByLibraryAndKeyAsync(itemRef.library_id, itemRef.zotero_key))
        );

        logger(`updateSourceCitationsAtom: Found ${items.length} items for ${citationIds.length} citations`);

        // Create SourceCitation objects
        const citations: SourceCitation[] = [];
        items.forEach((item, index) => {
            if (!item) return;
            const source = createSourceFromItemSync(item);
            if (!source) return;
            
            const parentItem = getParentItem(source);
            const itemToCite = item.isNote() ? item : parentItem || item;
            
            if (itemToCite) {
                citations.push({
                    ...source,
                    citation: getCitationFromItem(itemToCite),
                    name: getDisplayNameFromItem(itemToCite),
                    formatted_citation: getReferenceFromItem(itemToCite),
                    url: createZoteroURI(item),
                    icon: item.getItemTypeIconName(),
                    numericCitation: (index + 1).toString()
                });
            }
        });

        logger(`updateSourceCitationsAtom: Setting sourceCitationsAtom with ${citations.length} citations`);
        set(sourceCitationsAtom, citations);
    }
);