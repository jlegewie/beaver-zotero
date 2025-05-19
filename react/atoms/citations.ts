import { atom } from 'jotai';
import { threadMessagesAtom } from '../atoms/threads';
import { SourceCitation } from '../types/sources';
import { createThreadSourceFromItem, getParentItem, getCitationFromItem, getReferenceFromItem, getDisplayNameFromItem } from '../utils/sourceUtils';
import { createZoteroItemReference } from "../types/chat/apiTypes";
import { createZoteroURI } from "../utils/zoteroURI";

/*
 * Source citations
 *
 * sourceCitationsAtom are all sources cited in assistant messages
 * formated as SourceCitation objects. They are used to display the 
 * in-line citations and the source list in the assistant message footer.
 * 
 */
export const sourceCitationsAtom = atom<SourceCitation[]>((get) => {
    const messages = get(threadMessagesAtom);
    
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
    
    // Convert to SourceCitation objects
    const citations: SourceCitation[] = [];
    
    citationIds.forEach((citationId, index) => {
        const itemRef = createZoteroItemReference(citationId);
        if (!itemRef) return;
        
        const item = Zotero.Items.getByLibraryAndKey(itemRef.library_id, itemRef.zotero_key);
        if (!item) return;
        
        const source = createThreadSourceFromItem(item);
        const parentItem = getParentItem(source);
        const itemToCite = item.isNote() ? item : parentItem || item;
        
        if (itemToCite) {
            citations.push({
                ...source,
                citation: getCitationFromItem(itemToCite),
                name: getDisplayNameFromItem(itemToCite),
                reference: getReferenceFromItem(itemToCite),
                url: createZoteroURI(item),
                icon: item.getItemTypeIconName(),
                numericCitation: (index + 1).toString()
            });
        }
    });
    
    return citations;
});