import React from 'react';
import { FulltextRetrievalResult } from '../../agents/toolResultTypes';
import { createZoteroItemReference } from '../../types/zotero';
import ZoteroItemsList from '../ui/ZoteroItemsList';

interface FulltextRetrievalResultViewProps {
    result: FulltextRetrievalResult;
}

/**
 * Renders the result of a fulltext retrieval tool (read_fulltext).
 * Shows the attachment that was retrieved.
 */
export const FulltextRetrievalResultView: React.FC<FulltextRetrievalResultViewProps> = ({ result }) => {
    // Parse attachment_id format '<library_id>-<zotero_key>' to ZoteroItemReference
    const attachmentRef = createZoteroItemReference(result.attachment.attachment_id);

    if (!attachmentRef) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                Unable to parse attachment reference
            </div>
        );
    }

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={[attachmentRef]} />
        </div>
    );
};

export default FulltextRetrievalResultView;

