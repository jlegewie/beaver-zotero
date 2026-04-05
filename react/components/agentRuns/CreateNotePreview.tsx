import React from 'react';
import MarkdownRenderer from '../messages/MarkdownRenderer';
import { openNoteByKey } from '../../utils/sourceUtils';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface CreateNotePreviewProps {
    /** The markdown content of the note */
    content: string;
    /** Result data after the note has been created */
    resultData?: Record<string, any>;
    /** Current status of the action */
    status?: ActionStatus;
}

export const CreateNotePreview: React.FC<CreateNotePreviewProps> = ({
    content,
    resultData,
    status,
}) => {
    const trimmedContent = content.replace(/^\n+/, '');

    return (
        <div className="display-flex flex-col">
            <div className="display-flex flex-col px-25 pt-2 pb-2 gap-2">
                <div className="markdown note-body">
                    <MarkdownRenderer
                        content={trimmedContent || '_No content yet._'}
                        enableNoteBlocks={false}
                    />
                </div>
            </div>
            {resultData?.zotero_key && status === 'applied' && (
                <div
                    className="font-color-link text-xs px-3 pb-2 cursor-pointer"
                    onClick={() => {
                        const libId = resultData.library_id;
                        const key = resultData.zotero_key;
                        if (libId && key) {
                            openNoteByKey(libId, key);
                        }
                    }}
                >
                    Open note
                </div>
            )}
        </div>
    );
};
