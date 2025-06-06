import React from 'react';
import { useAtomValue } from 'jotai';
import { aggregatedErrorMessagesForSkippedFilesAtom } from '../../atoms/files';

export const SkippedProcessingTooltipContent: React.FC = () => {
    const aggregatedMessages = useAtomValue(aggregatedErrorMessagesForSkippedFilesAtom);

    return (
        <div className="display-flex flex-col gap-1">
            <div className="text-base font-color-secondary mb-1 whitespace-nowrap">Reasons for skipping</div>
            {(!aggregatedMessages || Object.keys(aggregatedMessages).length === 0) ? (
                <div className="text-base font-color-secondary">No specific reasons available.</div>
            ) : (
                Object.entries(aggregatedMessages).map(([message, count]) => (
                    <div key={message} className="display-flex justify-between items-center text-base whitespace-nowrap">
                        <span className="font-color-tertiary mr-4">{message}:</span>
                        <span className="font-color-secondary font-mono">{count}</span>
                    </div>
                ))
            )}
        </div>
    );
};