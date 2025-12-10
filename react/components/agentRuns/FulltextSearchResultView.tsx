import React from 'react';
import { FulltextSearchResult, ChunkResultDehydrated } from '../../agents/toolResultTypes';
import { createZoteroItemReference } from '../../types/zotero';
import ZoteroItemsList from '../ui/ZoteroItemsList';

interface FulltextSearchResultViewProps {
    result: FulltextSearchResult;
}

/**
 * Represents a unique attachment with its associated page numbers.
 */
interface AttachmentWithPages {
    attachment_id: string;
    pages: number[];
}

/**
 * Extract unique attachments from chunks, preserving page information.
 */
function extractUniqueAttachments(chunks: ChunkResultDehydrated[]): AttachmentWithPages[] {
    const attachmentMap = new Map<string, Set<number>>();

    for (const chunk of chunks) {
        if (!attachmentMap.has(chunk.attachment_id)) {
            attachmentMap.set(chunk.attachment_id, new Set());
        }
        if (chunk.page !== undefined && chunk.page !== null) {
            attachmentMap.get(chunk.attachment_id)!.add(chunk.page);
        }
    }

    return Array.from(attachmentMap.entries()).map(([attachment_id, pages]) => ({
        attachment_id,
        pages: Array.from(pages).sort((a, b) => a - b)
    }));
}

/**
 * Renders the result of a fulltext search tool (search_fulltext, search_fulltext_keywords, read_passages).
 * Shows a list of unique attachments from the chunks.
 */
export const FulltextSearchResultView: React.FC<FulltextSearchResultViewProps> = ({ result }) => {
    if (result.chunks.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No results found
            </div>
        );
    }

    // Extract unique attachments with their page numbers
    const attachmentsWithPages = extractUniqueAttachments(result.chunks);

    // Parse attachment_id format '<library_id>-<zotero_key>' to ZoteroItemReference[]
    const attachmentReferences = attachmentsWithPages
        .map(att => createZoteroItemReference(att.attachment_id))
        .filter((ref): ref is NonNullable<typeof ref> => ref !== null);

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={attachmentReferences} />
        </div>
    );
};

export default FulltextSearchResultView;

