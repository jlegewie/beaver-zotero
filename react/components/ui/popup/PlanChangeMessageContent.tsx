import React, { useEffect } from 'react';
import { PopupMessage } from '../../../types/popupMessage';
import { useAtomValue, useSetAtom } from 'jotai';
import { useFileStatus } from '../../../hooks/useFileStatus';
import { fileStatusStatsAtom } from '../../../atoms/files';
import { ProgressBar } from '../../status/ProgressBar';
import { updatePopupMessageAtom, removePopupMessageAtom } from '../../../utils/popupMessageUtils';
import { useIndexingCompleteMessage } from '../../../hooks/useIndexingCompleteMessage';

interface PlanChangeMessageContentProps {
    message: PopupMessage;
}

const PlanChangeMessageContent: React.FC<PlanChangeMessageContentProps> = ({ message }) => {
    const updatePopupMessage = useSetAtom(updatePopupMessageAtom);
    const removePopupMessage = useSetAtom(removePopupMessageAtom);

    // Realtime listening for file status updates
    const { connectionStatus } = useFileStatus();
    const fileStats = useAtomValue(fileStatusStatsAtom);
    useIndexingCompleteMessage();

    useEffect(() => {
        // Remove the message when the progress is 100%
        if(fileStats && fileStats.progress >= 100) {
            updatePopupMessage({
                messageId: message.id,
                updates: {expire: true}
            });
        }
    }, [fileStats]);


    const getProcessingLeftText = (): string => {
        if(connectionStatus === 'failed') return "";
        if (!fileStats) return "Loading status...";
        
        const textParts: string[] = [];
        if (fileStats.completedFiles > 0) textParts.push(`${fileStats.completedFiles.toLocaleString()} done`);
        if (fileStats.activeProcessingCount > 0) textParts.push(`${fileStats.activeProcessingCount.toLocaleString()} processing`);
        
        return textParts.join(", ");
    };

    return (
        <div className="display-flex flex-col gap-4">
            <div className="font-color-secondary text-base">
                {message.text}
            </div>

            <div className="display-flex flex-col gap-3 items-start flex-1">

                {/* Progress bar */}
                {fileStats && fileStats.totalProcessingCount > 0 && (
                    <div className="w-full">
                        <ProgressBar progress={fileStats.progress} />
                    </div>
                )}
                {fileStats && fileStats.totalProcessingCount === 0 && (
                    <div className="font-color-tertiary text-base w-full">
                    {getProcessingLeftText()}
                </div>
                )}
            </div>
        </div>
    );
};

export default PlanChangeMessageContent;