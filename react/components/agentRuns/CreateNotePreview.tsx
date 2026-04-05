import React from 'react';
import MarkdownRenderer from '../messages/MarkdownRenderer';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface CreateNotePreviewProps {
    /** The markdown content of the note */
    content: string;
    /** Result data after the note has been created */
    resultData?: Record<string, any>;
    /** Current status of the action */
    status?: ActionStatus;
    /** Whether tool call arguments are actively streaming */
    isStreaming?: boolean;
}

export const CreateNotePreview: React.FC<CreateNotePreviewProps> = ({
    content,
    resultData,
    status,
    isStreaming,
}) => {
    const trimmedContent = content.replace(/^\n+/, '');

    return (
        <div className="display-flex flex-col">
            <div className="display-flex flex-col px-25 pt-2 pb-2 gap-2">
                <div className="markdown note-body">
                    <MarkdownRenderer
                        content={trimmedContent || (isStreaming ? '_Generating..._' : '_No content yet._')}
                        enableNoteBlocks={false}
                    />
                </div>
            </div>
        </div>
    );
};
