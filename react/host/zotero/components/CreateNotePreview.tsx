import React, { useLayoutEffect, useRef, useState } from 'react';
import MarkdownRenderer from '../../../components/messages/MarkdownRenderer';

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
    /** Cap long note bodies for the end-of-run review card. */
    compact?: boolean;
}

export const CreateNotePreview: React.FC<CreateNotePreviewProps> = ({
    content,
    resultData,
    status,
    isStreaming,
    compact = false,
}) => {
    const trimmedContent = content.replace(/^\n+/, '');
    const contentRef = useRef<HTMLDivElement>(null);
    const [isTruncated, setIsTruncated] = useState(false);

    useLayoutEffect(() => {
        const element = contentRef.current;
        if (!element || !compact) {
            setIsTruncated(false);
            return;
        }

        const updateTruncation = () => {
            setIsTruncated(element.scrollHeight > element.clientHeight + 1);
        };
        updateTruncation();

        // Re-check when pane or window width changes cause the markdown to
        // reflow. Derive ResizeObserver from the owning document rather than
        // assuming this React root belongs to the main Zotero window.
        const ResizeObserverCtor = element.ownerDocument.defaultView?.ResizeObserver;
        if (!ResizeObserverCtor) return;
        const observer = new ResizeObserverCtor(updateTruncation);
        observer.observe(element);
        return () => observer.disconnect();
    }, [compact, trimmedContent]);

    if (!trimmedContent) {
        return null;
    }

    return (
        <div className="display-flex flex-col">
            <div className={`display-flex flex-col px-25 pt-2 gap-2 ${isStreaming ? 'pb-2' : ''}`}>
                <div
                    ref={contentRef}
                    className={`markdown note-body ${compact ? 'create-note-preview-compact' : ''} ${isTruncated ? 'is-truncated' : ''}`}
                >
                    <MarkdownRenderer
                        content={trimmedContent}
                        enableNoteBlocks={false}
                    />
                </div>
            </div>
        </div>
    );
};
