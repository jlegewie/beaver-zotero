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
        if(connectionStatus === 'failed') return "";
        if (!fileStatusSummary) return "Loading status...";
        
        const textParts: string[] = [];
        if (fileStatusSummary.completedFiles > 0) textParts.push(`${fileStatusSummary.completedFiles.toLocaleString()} done`);
        if (fileStatusSummary.processingProcessingCount > 0) textParts.push(`${fileStatusSummary.processingProcessingCount.toLocaleString()} processing`);
        
        return textParts.join(", ");
    };

    return (
        <div className="display-flex flex-col gap-4">
            <div className="font-color-secondary text-base">
                {message.text}
            </div>

            <div className="display-flex flex-col gap-3 items-start flex-1">

                {/* Progress bar */}
                {showProgress && fileStatusSummary && fileStatusSummary.totalProcessingCount > 0 && (
                    <div className="w-full">
                        <ProgressBar progress={fileStatusSummary.progress} />
                    </div>
                )}
                {showProgress && fileStatusSummary && fileStatusSummary.totalProcessingCount === 0 && (
                    <div className="font-color-tertiary text-base w-full">
                    {getProcessingLeftText()}
                </div>
                )}
            </div>
        </div>
    );
};

export default PlanChangeMessageContent;