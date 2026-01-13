import React, { useMemo } from 'react';
import { ChunkReference } from '../../agents/toolResultTypes';
import ZoteroItemsList, { ZoteroItemReferenceWithLabel } from '../ui/ZoteroItemsList';
import { formatNumberRanges } from '../../utils/stringUtils';

interface FulltextSearchResultViewProps {
    chunks: ChunkReference[];
}

/**
 * Aggregate chunks to unique attachments with page numbers.
 */
function aggregateToAttachmentsWithPages(chunks: ChunkReference[]): (ZoteroItemReferenceWithLabel | { library_id: number; zotero_key: string })[] {
    const attachmentMap = new Map<string, { library_id: number; zotero_key: string; pages: number[] }>();
    
    for (const chunk of chunks) {
        const key = `${chunk.library_id}-${chunk.zotero_key}`;
        if (!attachmentMap.has(key)) {
            attachmentMap.set(key, {
                library_id: chunk.library_id,
                zotero_key: chunk.zotero_key,
                pages: []
            });
        }
        if (chunk.page !== undefined) {
            attachmentMap.get(key)!.pages.push(chunk.page + 1);
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
 * Renders the result of a fulltext search tool.
 * Shows unique attachments with page numbers from chunks.
 */
export const FulltextSearchResultView: React.FC<FulltextSearchResultViewProps> = ({ chunks }) => {
    const attachments = useMemo(() => aggregateToAttachmentsWithPages(chunks), [chunks]);

    if (attachments.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No results found
            </div>
        );
    }

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={attachments} />
        </div>
    );
};

export default FulltextSearchResultView;

