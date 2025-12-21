import React from 'react';
import { ChunkReference } from '../../agents/toolResultTypes';
import ZoteroItemsList from '../ui/ZoteroItemsList';

interface ReadPagesResultViewProps {
    attachment: ChunkReference;
}

/**
 * Renders the result of a fulltext retrieval tool (read_pages).
 * Shows the attachment that was retrieved with optional page info.
 */
export const ReadPagesResultView: React.FC<ReadPagesResultViewProps> = ({ attachment }) => {
    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={[attachment]} />
        </div>
    );
};

export default ReadPagesResultView;

