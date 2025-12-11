import React from 'react';
import { AttachmentWithPages } from '../../agents/toolResultTypes';
import ZoteroItemsList from '../ui/ZoteroItemsList';

interface FulltextSearchResultViewProps {
    attachments: AttachmentWithPages[];
}

/**
 * Renders the result of a fulltext search tool (search_fulltext, search_fulltext_keywords, read_passages).
 * Shows a list of unique attachments from the chunks.
 */
export const FulltextSearchResultView: React.FC<FulltextSearchResultViewProps> = ({ attachments }) => {
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

