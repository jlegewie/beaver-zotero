import React from 'react';
import ZoteroItemsList from '../ui/ZoteroItemsList';

interface ReadNoteResultViewProps {
    /** The note item reference */
    noteReference: {
        library_id: number;
        zotero_key: string;
    };
}

/**
 * Renders the result of a read_note tool call.
 * Shows the note item that was read.
 */
export const ReadNoteResultView: React.FC<ReadNoteResultViewProps> = ({
    noteReference,
}) => {
    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={[noteReference]} showParentItem={false} />
        </div>
    );
};

export default ReadNoteResultView;
