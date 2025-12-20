import React, { useMemo } from 'react';
import { ChunkReference } from '../../agents/toolResultTypes';
import { ZoteroItemReference } from '../../types/zotero';
import ZoteroItemsList from '../ui/ZoteroItemsList';

interface FulltextSearchResultViewProps {
    chunks: ChunkReference[];
}

/**
 * Aggregate chunks to unique attachments.
 * TODO: In the future, we may show page numbers alongside attachments.
 */
function aggregateToAttachments(chunks: ChunkReference[]): ZoteroItemReference[] {
    const seen = new Set<string>();
    const attachments: ZoteroItemReference[] = [];

    for (const chunk of chunks) {
        const key = `${chunk.library_id}-${chunk.zotero_key}`;
        if (!seen.has(key)) {
            seen.add(key);
            attachments.push({ library_id: chunk.library_id, zotero_key: chunk.zotero_key });
        }
    }

    return attachments;
}

/**
 * Renders the result of a fulltext search tool.
 * Currently shows unique attachments; can be extended to show chunk-level details.
 */
export const FulltextSearchResultView: React.FC<FulltextSearchResultViewProps> = ({ chunks }) => {
    const attachments = useMemo(() => aggregateToAttachments(chunks), [chunks]);

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

