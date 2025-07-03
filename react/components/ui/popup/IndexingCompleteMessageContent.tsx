import React from 'react';
import { PopupMessage } from '../../../types/popupMessage';
import Button from "../Button";
import { Icon, CancelCircleIcon, InformationCircleIcon, CheckmarkCircleIcon } from '../../icons/icons';
import { showFileStatusDetailsAtom } from '../../../atoms/ui';
import { useSetAtom, useAtomValue } from 'jotai';
import { newThreadAtom, currentThreadIdAtom } from '../../../atoms/threads';
import { updatePopupMessageAtom } from '../../../utils/popupMessageUtils';

interface IndexingCompleteMessageContentProps {
    message: PopupMessage;
}

const IndexingCompleteMessageContent: React.FC<IndexingCompleteMessageContentProps> = ({ message }) => {
    const newThread = useSetAtom(newThreadAtom);
    const setShowFileStatusDetails = useSetAtom(showFileStatusDetailsAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const updatePopupMessage = useSetAtom(updatePopupMessageAtom);

    if (!message.fileStatusSummary) return null;

    const fileStatusSummary = message.fileStatusSummary;
    const skippedFiles = fileStatusSummary?.planLimitCount;
    const failedFiles = fileStatusSummary?.failedCount;

    const handleShowDetails = async () => {
        if (currentThreadId !== null) {
            await newThread();
        }
        setShowFileStatusDetails(true);
        updatePopupMessage({
            messageId: message.id,
            updates: {
                expire: true,
                duration: 100
            }
        });
    };

    const getFileCountTexts = (): React.ReactNode[] => {
        const textParts: React.ReactNode[] = [];
        if (fileStatusSummary.completedFiles > 0) textParts.push(
            <div className="display-flex flex-row gap-2 items-center">
                <Icon icon={CheckmarkCircleIcon} className="scale-12 font-color-green" />
                <span className="font-color-green text-base">
                    {`${fileStatusSummary.completedFiles.toLocaleString()} file${fileStatusSummary.completedFiles > 1 ? 's' : ''} completed`}
                </span>
            </div>
        );
        if (failedFiles > 0) textParts.push(
            <div className="display-flex flex-row gap-2 items-center">
                <Icon icon={CancelCircleIcon} className="scale-12 font-color-red" />
                <span className="font-color-red text-base">
                    {`${failedFiles.toLocaleString()} file${failedFiles > 1 ? 's' : ''} failed`}
                </span>
            </div>
        );
        if (skippedFiles > 0) textParts.push(
            <div className="display-flex flex-row gap-2 items-center">
                <Icon icon={InformationCircleIcon} className="scale-12 font-color-yellow" />
                <span className="font-color-yellow text-base">
                    {`${skippedFiles.toLocaleString()} file${skippedFiles > 1 ? 's' : ''} skipped because of plan limits`}
                </span>
            </div>
        );

        return textParts;
    };

    return (
        <div className="display-flex flex-col gap-4 w-full">
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

            {message.planName === "free" && skippedFiles > 0 && (
                <div className="font-color-secondary text-base">
                    {`You can upgrade your plan to process more files.`}
                </div>
            )}

            <div className="display-flex flex-row gap-3 items-center">
                <div className="flex-1" />
                {message.planName === "free" && skippedFiles > 0 && (
                    <Button variant="surface">Upgrade</Button>
                )}
                {(skippedFiles > 0 || failedFiles > 0) && (
                    <Button onClick={handleShowDetails} variant="surface">View Details</Button>
                )}
            </div>

        </div>
    );
};

export default IndexingCompleteMessageContent;