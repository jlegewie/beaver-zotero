import React from 'react';
import ZoteroItemsList from '../ui/ZoteroItemsList';

interface ReadNoteResultViewProps {
    /** The note item reference */
    noteReference: {
        library_id: number;
        zotero_key: string;
    };
    /** The parent item reference (if child note) */
    parentReference?: {
        library_id: number;
        zotero_key: string;
    };
    /** Note title */
    title?: string;
    /** Total lines in the note */
    totalLines?: number;
    /** Lines range returned */
    linesReturned?: string;
}

/**
 * Renders the result of a read_note tool call.
 * Shows the parent item reference (if child note) or the note itself.
 */
export const ReadNoteResultView: React.FC<ReadNoteResultViewProps> = ({
    noteReference,
    parentReference,
    totalLines,
    linesReturned,
}) => {
    // Show parent item if available, otherwise show the note itself
    const displayRef = parentReference ?? noteReference;
    // Show "Line x-x" if a subset was returned; omit if entire note
    const isFullNote = !linesReturned || linesReturned === `1-${totalLines}`;
    const label = isFullNote ? undefined : `Line ${linesReturned}`;

    const attachments = label
        ? [{ ...displayRef, label }]
        : [displayRef];

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={attachments} />
        </div>
    );
};

export default ReadNoteResultView;
