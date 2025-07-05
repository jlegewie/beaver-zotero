import React from "react";
import { AlertIcon, InformationCircleIcon } from "../icons/icons";
import { useAtomValue } from "jotai";
import { StepThreeIcon, CancelIcon, CheckmarkIcon, SpinnerIcon } from "./icons";
import { ProgressBar } from "./ProgressBar";
import { fileStatusSummaryAtom } from "../../atoms/files";
import { FailedProcessingTooltipContent } from "./FailedProcessingTooltipContent";
import PaginatedFailedProcessingList from "./PaginatedFailedProcessingList";
import { SkippedProcessingTooltipContent } from "./SkippedProcessingTooltipContent";
import { FileStatusConnection } from "../../hooks/useFileStatus";

const FileProcessingStatus: React.FC<{ connectionStatus: FileStatusConnection['connectionStatus'] }> = ({ connectionStatus }) => {
    const fileStats = useAtomValue(fileStatusSummaryAtom);

    const getProcessingIcon = (): React.ReactNode => {
        if (!fileStats) return StepThreeIcon;
        if (!fileStats.completedFiles && !fileStats.failedProcessingCount && !fileStats.processingProcessingCount) return StepThreeIcon;
        
        const complete = fileStats.processingProgress >= 100 && fileStats.processingProcessingCount === 0 && fileStats.queuedProcessingCount === 0;
        // if (complete && fileStats.failedProcessingCount > 0) return CancelIcon;
        if (complete) return CheckmarkIcon;
        
        return SpinnerIcon; // Default to spinner if still processing or stats are unavailable
    };

    const getProcessingLeftText = (): string => {
        if(connectionStatus === 'failed') return "";
        if (!fileStats) return "Loading status...";
        
        const textParts: string[] = [];
        if (fileStats.completedFiles > 0) textParts.push(`${fileStats.completedFiles.toLocaleString()} done`);
        if (fileStats.processingProcessingCount > 0) textParts.push(`${fileStats.processingProcessingCount.toLocaleString()} processing`);

        const numFilesToProcess = fileStats.queuedProcessingCount + fileStats.processingProcessingCount;
        
        if (textParts.length === 0 && numFilesToProcess > 0) return `Waiting to process ${numFilesToProcess.toLocaleString()} files...`;
        if (textParts.length === 0 && numFilesToProcess === 0) return "No files to process.";

        return textParts.join(", ");
    };
    
    if (!fileStats || !fileStats.fileStatusAvailable) {
        return (
            <div className="display-flex flex-col gap-4 p-3 border-popup rounded-md bg-quinary min-w-0">
                <div className="display-flex flex-row gap-4">
                    <div className="mt-1">{SpinnerIcon}</div>
                    <div className="display-flex flex-col gap-3 items-start flex-1">
                        <div className="font-color-secondary text-lg">File Processing</div>
                        <div className="font-color-tertiary text-base">Initializing...</div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="display-flex flex-col gap-4 p-3 border-popup rounded-md bg-quinary min-w-0">
            <div className="display-flex flex-row gap-4">
                <div className="mt-1">
                    {getProcessingIcon()}
                </div>
                <div className="display-flex flex-col gap-3 items-start flex-1">

                    {/* Title */}
                    <div className="display-flex flex-row items-center gap-3 w-full min-w-0">
                        <div className="font-color-secondary text-lg">
                            File Processing
                        </div>
                        <div className="flex-1"/>
                        {connectionStatus === 'connected' && fileStats && (
                            <div className="font-color-tertiary text-base">
                                {fileStats.totalProcessingCount.toLocaleString()} Files
                            </div>
                        )}
                        {connectionStatus === 'failed' && (
                            <div className="font-color-tertiary text-sm items-end">
                                Connection failed
                            </div>
                        )}
                    </div>

                    {/* Progress bar and text */}
                    {fileStats && fileStats.totalProcessingCount > 0 && (
                        <div className="w-full">
                            <ProgressBar progress={fileStats.processingProgress} />

                                <div className="display-flex flex-row gap-4">
                                    <div className="font-color-tertiary text-base">
                                        {getProcessingLeftText()}
                                    </div>
                                    <div className="flex-1"/>
                                    <div className="font-color-tertiary text-base">
                                        {`${Math.min(fileStats.processingProgress, 100).toFixed(1)}%`}
                                    </div>
                                </div>

                        </div>
                    )}
                    {fileStats && fileStats.totalProcessingCount === 0 && (
                        <div className="font-color-tertiary text-base w-full">
                        {getProcessingLeftText()}
                    </div>
                    )}
                </div>
            </div>

            {/* Failed processing files */}
            {fileStats.failedProcessingCount > 0 && (
                <PaginatedFailedProcessingList
                    statuses={["failed_user", "failed_system"]}
                    count={fileStats.failedProcessingCount}
                    title={`Failed file${fileStats.failedProcessingCount > 1 ? 's' : ''}`}
                    tooltipTitle="Processing error codes"
                    tooltipContent={<FailedProcessingTooltipContent />}
                    icon={AlertIcon}
                    textColorClassName="font-color-red"
                />
            )}

            {/* Plan limit files */}
            {fileStats.planLimitProcessingCount > 0 && (
                <PaginatedFailedProcessingList
                    statuses={["plan_limit"]}
                    count={fileStats.planLimitProcessingCount}
                    title={`Skipped file${fileStats.planLimitProcessingCount > 1 ? 's' : ''} because of plan limits`}
                    tooltipTitle="Plan limits"
                    tooltipContent={<SkippedProcessingTooltipContent />}
                    icon={InformationCircleIcon}
                    // textColorClassName="font-color-yellow"
                    textColorClassName="font-color-secondary"
                />
            )}
            
        </div>
    );
};

export default FileProcessingStatus; 