import React from 'react';
import { ChunkReference } from '../../agents/toolResultTypes';
import ZoteroItemsList from '../ui/ZoteroItemsList';

interface FulltextRetrievalResultViewProps {
    attachment: ChunkReference;
}

/**
 * Renders the result of a fulltext retrieval tool (read_fulltext, retrieve_fulltext).
 * Shows the attachment that was retrieved with optional page info.
 */
export const FulltextRetrievalResultView: React.FC<FulltextRetrievalResultViewProps> = ({ attachment }) => {
    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={[attachment]} />
        </div>
    );
};

export default FulltextRetrievalResultView;

