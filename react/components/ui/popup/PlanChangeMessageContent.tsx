import React, { useEffect } from 'react';
import { PopupMessage } from '../../../types/popupMessage';
import { useAtomValue, useSetAtom } from 'jotai';
import { useFileStatus } from '../../../hooks/useFileStatus';
import { fileStatusSummaryAtom } from '../../../atoms/files';
import { ProgressBar } from '../../status/ProgressBar';
import {  removePopupMessageAtom } from '../../../utils/popupMessageUtils';
import { useIndexingCompleteMessage } from '../../../hooks/useIndexingCompleteMessage';

interface PlanChangeMessageContentProps {
    message: PopupMessage;
}

const PlanChangeMessageContent: React.FC<PlanChangeMessageContentProps> = ({ message }) => {
    const removePopupMessage = useSetAtom(removePopupMessageAtom);

    const showProgress = message.showProgress === undefined ? true : message.showProgress;

    // Realtime listening for file status updates
    const { connectionStatus } = useFileStatus();
    const fileStatusSummary = useAtomValue(fileStatusSummaryAtom);
    useIndexingCompleteMessage();

    useEffect(() => {
        // Remove the message when the progress is 100%
        if(fileStatusSummary && fileStatusSummary.progress >= 100) {
            removePopupMessage(message.id);
        }
    }, [fileStatusSummary]);


    const getProcessingLeftText = (): string => {
        if(connectionStatus === 'error' || connectionStatus === 'idle' || connectionStatus === 'disconnected') return "No connection";
        if ((connectionStatus === 'connecting' || connectionStatus === 'reconnecting') || !fileStatusSummary) return "Loading status...";
        
        const textParts: string[] = [];
        if (fileStatusSummary.completedFiles > 0) textParts.push(`${fileStatusSummary.completedFiles.toLocaleString()} done`);
        if (fileStatusSummary.processingProcessingCount > 0) textParts.push(`${fileStatusSummary.processingProcessingCount.toLocaleString()} processing`);

        const numFilesToProcess = fileStatusSummary.queuedProcessingCount + fileStatusSummary.processingProcessingCount;
        
        if (textParts.length === 0 && numFilesToProcess > 0) return `Waiting to process ${numFilesToProcess.toLocaleString()} files...`;
        if (textParts.length === 0 && numFilesToProcess === 0) return "No files to process.";

        return textParts.join(", ");
    };

    return (
        <div className="display-flex flex-col gap-4">
            <div className="font-color-secondary text-base">
                {message.text}
            </div>

            {showProgress && fileStatusSummary && (
                <div className="display-flex flex-col items-start flex-1 w-full">

                    {/* Progress bar */}
                    <div className="w-full">
                        <ProgressBar progress={fileStatusSummary.progress} />
                    </div>
                    <div className="display-flex flex-row gap-4 w-full">
                        <div className="font-color-tertiary text-sm">
                            {getProcessingLeftText()}
                        </div>
                        <div className="flex-1"/>
                        <div className="font-color-tertiary text-sm">
                            {`${Math.min(fileStatusSummary.processingProgress, 100).toFixed(1)}%`}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PlanChangeMessageContent;