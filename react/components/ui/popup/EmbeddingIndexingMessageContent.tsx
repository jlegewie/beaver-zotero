import React from 'react';
import { PopupMessage } from '../../../types/popupMessage';
import { ProgressBar } from '../../status/ProgressBar';

interface EmbeddingIndexingMessageContentProps {
    message: PopupMessage;
}

/**
 * Content component for embedding indexing progress popup.
 * Shows a progress bar with percentage.
 */
const EmbeddingIndexingMessageContent: React.FC<EmbeddingIndexingMessageContentProps> = ({ message }) => {
    const progress = message.progress ?? 0;

    return (
        <div className="display-flex flex-col gap-2 w-full">
            <div className="display-flex flex-row items-center gap-3">
                <div className="flex-1">
                    <ProgressBar progress={progress} />
                </div>
                <span className="font-color-tertiary text-base" style={{ minWidth: '45px', textAlign: 'right' }}>
                    {`${progress.toFixed(0)}%`}
                </span>
            </div>
            {message.text && (
                <div className="font-color-tertiary text-sm">
                    {message.text}
                </div>
            )}
        </div>
    );
};

export default EmbeddingIndexingMessageContent;

