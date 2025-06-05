import React from 'react';
import { useAtomValue } from 'jotai';
import { aggregatedErrorMessagesForSkippedFilesAtom } from '../../atoms/files';

export const SkippedProcessingTooltipContent: React.FC = () => {
    const aggregatedMessages = useAtomValue(aggregatedErrorMessagesForSkippedFilesAtom);

    return (
        <div className="display-flex flex-col gap-2 max-w-xs p-1">
            <div className="text-base font-bold font-color-primary">Reasons for Skipped Files</div>
            <div className="display-flex flex-col gap-1">
                {Object.entries(aggregatedMessages).map(([message, count]) => (
                    <div key={message} className="display-flex flex-row justify-between gap-4">
                        <span className="font-color-secondary">{message}</span>
                        <span className="font-color-tertiary">{count.toLocaleString()}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}; 