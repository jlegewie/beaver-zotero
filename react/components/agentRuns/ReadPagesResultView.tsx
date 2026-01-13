import React from 'react';
import { PageReference } from '../../agents/toolResultTypes';
import ZoteroItemsList, { ZoteroItemReferenceWithLabel } from '../ui/ZoteroItemsList';
import { formatNumberRanges } from '../../utils/stringUtils';

interface ReadPagesResultViewProps {
    pages: PageReference[];
}

/**
 * Aggregate chunks to unique attachments with page numbers.
 */
function aggregateToAttachmentsWithPages(pages: PageReference[]): (ZoteroItemReferenceWithLabel | { library_id: number; zotero_key: string })[] {
    const attachmentMap = new Map<string, { library_id: number; zotero_key: string; pages: number[] }>();
    
    for (const page of pages) {
        const key = `${page.library_id}-${page.zotero_key}`;
        if (!attachmentMap.has(key)) {
            attachmentMap.set(key, {
                library_id: page.library_id,
                zotero_key: page.zotero_key,
                pages: []
            });
        }
        if (page.page_number !== undefined) {
            attachmentMap.get(key)!.pages.push(page.page_number);
        }
    }

    return Array.from(attachmentMap.values()).map(data => {
        if (data.pages.length > 0) {
            return {
                library_id: data.library_id,
                zotero_key: data.zotero_key,
                label: `Page ${formatNumberRanges(data.pages, ",")}`
            };
        }
        return {
            library_id: data.library_id,
            zotero_key: data.zotero_key
        };
    });
}

/**
 * Renders the result of a fulltext retrieval tool (read_pages).
 * Shows the attachment that was retrieved with page info.
 */
export const ReadPagesResultView: React.FC<ReadPagesResultViewProps> = ({ pages }) => {
    const attachments = aggregateToAttachmentsWithPages(pages);

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={attachments} />
        </div>
    );
};

export default ReadPagesResultView;

