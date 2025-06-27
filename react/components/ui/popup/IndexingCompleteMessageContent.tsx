import React from 'react';
import { PopupMessage } from '../../../types/popupMessage';
import Button from "../Button";
import { Icon, CancelCircleIcon, InformationCircleIcon, CheckmarkCircleIcon } from '../../icons/icons';

interface IndexingCompleteMessageContentProps {
    message: PopupMessage;
}

const IndexingCompleteMessageContent: React.FC<IndexingCompleteMessageContentProps> = ({ message }) => {

    if (!message.fileStats) return null;

    const fileStats = message.fileStats;
    const skippedFiles = message.fileStats?.skippedProcessingCount + message.fileStats?.uploadSkippedCount;
    const failedFiles = message.fileStats?.failedProcessingCount + message.fileStats?.uploadFailedCount;
    const balanceInsufficientFiles = message.fileStats?.balanceInsufficientProcessingCount;

    const getFileCountTexts = (): React.ReactNode[] => {
        const textParts: React.ReactNode[] = [];
        if (fileStats.completedFiles > 0) textParts.push(
            <div className="display-flex flex-row gap-2 items-center">
                <Icon icon={CheckmarkCircleIcon} className="scale-12 font-color-green" />
                <span className="font-color-green text-base">
                    {`${fileStats.completedFiles.toLocaleString()} files completed`}
                </span>
            </div>
        );
        if (failedFiles > 0) textParts.push(
            <div className="display-flex flex-row gap-2 items-center">
                <Icon icon={CancelCircleIcon} className="scale-12 font-color-red" />
                <span className="font-color-red text-base">
                    {`${failedFiles.toLocaleString()} files failed`}
                </span>
            </div>
        );
        if (skippedFiles > 0) textParts.push(
            <div className="display-flex flex-row gap-2 items-center">
                <Icon icon={InformationCircleIcon} className="scale-12 font-color-yellow" />
                <span className="font-color-yellow text-base">
                    {`${skippedFiles.toLocaleString()} files skipped`}
                </span>
            </div>
        );
        if (balanceInsufficientFiles > 0) textParts.push(
            <div className="display-flex flex-row gap-2 items-center">
                <Icon icon={InformationCircleIcon} className="scale-12 font-color-yellow" />
                <span className="font-color-yellow text-base">
                    {`${balanceInsufficientFiles.toLocaleString()} files exceeded your plan's limit.`}
                </span>
            </div>
        );
        return textParts;
    };

    return (
        <div className="display-flex flex-col gap-4">
            <div className="font-color-secondary text-base">
                {message.text}
            </div>

            <div className="display-flex flex-col gap-2 items-start flex-1">
                {getFileCountTexts().map((text, index) => (
                    <div key={index} className="font-color-secondary text-base">
                        {text}
                    </div>
                ))}
            </div>

            {message.planName === "free" && balanceInsufficientFiles > 0 && (
                <div className="font-color-secondary text-base">
                    {`You can upgrade your plan to process more files.`}
                </div>
            )}

            <div className="display-flex flex-row gap-3 items-center">
                <div className="flex-1" />
                {message.planName === "free" && balanceInsufficientFiles > 0 && (
                    <Button variant="surface">Upgrade</Button>
                )}
                {(skippedFiles > 0 || failedFiles > 0) && (
                    <Button variant="surface">View Details</Button>
                )}
            </div>

        </div>
    );
};

export default IndexingCompleteMessageContent;