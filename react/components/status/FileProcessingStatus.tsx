import React from "react";
import { AlertIcon, InformationCircleIcon } from "../icons/icons";
import { useAtomValue } from "jotai";
import { StepThreeIcon, CancelIcon, CheckmarkIcon, SpinnerIcon } from "./icons";
import { ProgressBar } from "./ProgressBar";
import { fileStatusStatsAtom } from "../../atoms/files";
import { FailedProcessingTooltipContent } from "./FailedProcessingTooltipContent";
import ExpandableAttachmentList from "./ExpandableAttachmentList";
import { SkippedProcessingTooltipContent } from "./SkippedProcessingTooltipContent";
import { useErrorCodeStats } from "../../hooks/useErrorCodeStats";

const FileProcessingStatus: React.FC = () => {
    useErrorCodeStats();
    const fileStats = useAtomValue(fileStatusStatsAtom);

    const getProcessingIcon = (): React.ReactNode => {
        if (!fileStats) return StepThreeIcon;
        if (!fileStats.completedFiles && !fileStats.failedProcessingCount && !fileStats.activeProcessingCount) return StepThreeIcon;
        
        const complete = fileStats.processingProgress >= 100 && fileStats.activeProcessingCount === 0 && fileStats.queuedProcessingCount === 0;
        // if (complete && fileStats.failedProcessingCount > 0) return CancelIcon;
        if (complete) return CheckmarkIcon;
        
        return SpinnerIcon; // Default to spinner if still processing or stats are unavailable
    };

    const getProcessingLeftText = (): string => {
        if (!fileStats) return "Loading status...";
        
        const textParts: string[] = [];
        if (fileStats.completedFiles > 0) textParts.push(`${fileStats.completedFiles.toLocaleString()} done`);
        if (fileStats.activeProcessingCount > 0) textParts.push(`${fileStats.activeProcessingCount.toLocaleString()} processing`);
        
        if (textParts.length === 0 && fileStats.totalProcessingCount > 0) return "Waiting to process...";
        if (textParts.length === 0 && fileStats.totalProcessingCount === 0) return "No files to process.";

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
                        {fileStats && (
                            <div className="font-color-tertiary text-base">
                                {fileStats.totalProcessingCount.toLocaleString()} Files
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

            {/* Failed and Skipped processing items */}
            {fileStats.skippedProcessingCount > 0 && (
                <ExpandableAttachmentList
                    status="skipped"
                    count={fileStats.skippedProcessingCount}
                    title="Skipped Files"
                    tooltipTitle="Processing skip reasons"
                    tooltipContent={<SkippedProcessingTooltipContent />}
                    icon={InformationCircleIcon}
                    // textColorClassName="font-color-yellow"
                    textColorClassName="font-color-secondary"
                />
            )}
            {fileStats.failedProcessingCount > 0 && (
                <ExpandableAttachmentList
                    status="failed"
                    count={fileStats.failedProcessingCount}
                    title="Failed Files"
                    tooltipTitle="Processing error codes"
                    tooltipContent={<FailedProcessingTooltipContent />}
                    icon={AlertIcon}
                    textColorClassName="font-color-red"
                />
            )}
        </div>
    );
};

export default FileProcessingStatus; 