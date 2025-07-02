import React from "react";
import { AlertIcon, InformationCircleIcon } from "../icons/icons";
import { useAtomValue } from "jotai";
import { StepTwoIcon, CancelIcon, CheckmarkIcon, SpinnerIcon } from "./icons";
import { ProgressBar } from "./ProgressBar";
import { fileStatusSummaryAtom } from "../../atoms/files";
import { FileStatusConnection } from "../../hooks/useFileStatus";
import PaginatedFailedUploadsList from "./PaginatedFailedUploadsList";


const FileUploadStatus: React.FC<{ connectionStatus: FileStatusConnection['connectionStatus'] }> = ({ connectionStatus }) => {
    const fileStatusSummary = useAtomValue(fileStatusSummaryAtom);
    const isUploadComplete = fileStatusSummary && fileStatusSummary.uploadPendingCount === 0 && fileStatusSummary.totalFiles > 0;

    const getUploadIcon = (): React.ReactNode => {
        if (!fileStatusSummary) return StepTwoIcon;
        if (!fileStatusSummary.uploadCompletedCount && !fileStatusSummary.uploadFailedCount && !fileStatusSummary.uploadPlanLimitCount) return StepTwoIcon;

        // Use upload stats from hook
        if (fileStatusSummary) {
            if (fileStatusSummary.uploadFailedCount > 0) return CancelIcon;
            if (isUploadComplete) return CheckmarkIcon;
        }
        
        if (fileStatusSummary.uploadFailedCount > 0) return CancelIcon;
        return SpinnerIcon;
    };

    const getUploadLeftText = (): string => {
        if (fileStatusSummary === null  || fileStatusSummary === undefined || !fileStatusSummary) return "Waiting to upload...";
        
        const textParts: string[] = [];
        if (fileStatusSummary.totalFiles > 0) textParts.push(`${fileStatusSummary.uploadCompletedCount.toLocaleString()} done`);
        if (fileStatusSummary.uploadFailedCount > 0) textParts.push(`${fileStatusSummary.uploadFailedCount.toLocaleString()} failed`);
        if (fileStatusSummary.uploadPlanLimitCount > 0) textParts.push(`${fileStatusSummary.uploadPlanLimitCount.toLocaleString()} skipped`);
        return textParts.join(", ");
    };
    
    return (
        <div className="display-flex flex-col gap-4 p-3 border-popup rounded-md bg-quinary min-w-0">
            <div className="display-flex flex-row gap-4">
                <div className="mt-1">
                    {getUploadIcon()}
                </div>
                <div className="display-flex flex-col gap-3 items-start flex-1">

                    {/* Title */}
                    <div className="display-flex flex-row items-center gap-3 w-full min-w-0">
                        <div className={`${fileStatusSummary?.uploadFailedCount && fileStatusSummary.uploadFailedCount > 0 ? 'font-color-red' : 'font-color-secondary'} text-lg`}>
                            File Uploads
                        </div>
                        <div className="flex-1"/>
                        {fileStatusSummary && (
                            <div className="font-color-tertiary text-base">
                                {fileStatusSummary.totalFiles.toLocaleString()} Files
                            </div>
                        )}
                    </div>

                    {/* Progress bar and text */}
                    <div className="w-full">
                        <ProgressBar progress={fileStatusSummary.uploadProgress} />
                        <div className="display-flex flex-row gap-4">
                            {fileStatusSummary !== null && fileStatusSummary !== undefined && fileStatusSummary.uploadCompletedCount > 0 && (
                                <div className="font-color-tertiary text-base">
                                    {getUploadLeftText()}
                                </div>
                            )}
                            <div className="flex-1"/>
                            <div className="font-color-tertiary text-base">
                                {`${Math.min(fileStatusSummary.uploadProgress, 100).toFixed(1)}%`}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <PaginatedFailedUploadsList
                statuses={["failed"]}
                count={fileStatusSummary.uploadFailedCount}
                icon={AlertIcon}
                title="Failed Uploads"
                tooltipTitle="Failed Uploads"
                textColorClassName="font-color-red"
                // tooltipContent={<FailedProcessingTooltipContent />}
            />

            {/* Plan limit files */}
            <PaginatedFailedUploadsList
                statuses={["plan_limit"]}
                count={fileStatusSummary.uploadPlanLimitCount}
                icon={InformationCircleIcon}
                title={`Skipped file${fileStatusSummary.uploadPlanLimitCount > 1 ? 's' : ''} because of plan limits`}
                tooltipTitle="Skipped Uploads"
            />
        </div>
    );
};


export default FileUploadStatus;