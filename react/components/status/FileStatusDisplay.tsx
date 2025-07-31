import React from "react";
import { useAtomValue } from "jotai";
import { CheckmarkIcon, SpinnerIcon, CheckmarkIconGrey, AlertIcon as AlertIconIcon } from "./icons";
import { AlertIcon, InformationCircleIcon } from "../icons/icons";
import { ProgressBar } from "./ProgressBar";
import { fileStatusSummaryAtom } from "../../atoms/files";
import { FailedProcessingTooltipContent } from "./FailedProcessingTooltipContent";
import PaginatedFailedProcessingList from "./PaginatedFailedProcessingList";
import { SkippedProcessingTooltipContent } from "./SkippedProcessingTooltipContent";
import PaginatedFailedUploadsList from "./PaginatedFailedUploadsList";
import { ConnectionStatus } from "../../hooks/useFileStatus";

interface FileStatusDisplayProps {
    connectionStatus: ConnectionStatus;
}

const FileStatusDisplay: React.FC<FileStatusDisplayProps> = ({ connectionStatus }) => {
    const fileStats = useAtomValue(fileStatusSummaryAtom);
    if (connectionStatus == 'connected' && (!fileStats || !fileStats.fileStatusAvailable)) connectionStatus='connecting';

    // Calculate overall statistics
    const totalFiles = fileStats.totalFiles;
    
    // Files that are fully complete (either uploaded non-PDFs or processed PDFs)
    const filesNotProcessable = fileStats.uploadCompletedCount - fileStats.totalProcessingCount;
    const fullyCompleteFiles = filesNotProcessable + fileStats.completedFiles;
    
    // Files that are in progress (either uploading or processing)
    const activeFiles = fileStats.uploadPendingCount + fileStats.processingProcessingCount;
    
    // Files that are failed or skipped
    const failedOrSkippedFiles = fileStats.uploadFailedCount + fileStats.uploadPlanLimitCount + 
                                 fileStats.failedProcessingCount + fileStats.planLimitProcessingCount;
    
    // Overall progress calculation
    const overallProgress = totalFiles > 0 
        ? Math.min(((fullyCompleteFiles + failedOrSkippedFiles) / totalFiles) * 100, 100)
        : 0;

    // Determine if everything is complete
    const isComplete = activeFiles === 0 && fileStats.queuedProcessingCount === 0;
    
    // Determine icon
    const getStatusIcon = (): React.ReactNode => {
        if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting' || connectionStatus === 'polling') return SpinnerIcon;
        if (connectionStatus === 'error' || connectionStatus === 'idle' || connectionStatus === 'disconnected') return AlertIconIcon;
        if(totalFiles === 0) return CheckmarkIconGrey;
        if (isComplete) return CheckmarkIcon;
        return SpinnerIcon;
    };

    // Get status text
    const getStatusText = (): string => {
        const textParts: string[] = [];
        
        if (fullyCompleteFiles > 0) {
            textParts.push(`${fullyCompleteFiles.toLocaleString()} done`);
        }
        
        if (activeFiles > 0) {
            textParts.push(`${activeFiles.toLocaleString()} in progress`);
        }

        if (textParts.length === 0 && fileStats.queuedProcessingCount > 0) {
            textParts.push(`${fileStats.queuedProcessingCount.toLocaleString()} queued`);
        }
        
        if (textParts.length === 0) {
            if (totalFiles === 0) return "No files";
            return "";
        }
        
        return textParts.join(", ");
    };

    const getTitle = (): string => {
        if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') return "Connecting...";
        if (connectionStatus === 'error' || connectionStatus === 'idle' || connectionStatus === 'disconnected') return "Unable to connect...";
        if (totalFiles === 0) return "No files to process";
        return "File Processing";
    };

    return (
        <div className="display-flex flex-col gap-4 p-3 rounded-md bg-quinary min-w-0">
            <div className="display-flex flex-row gap-4">
                <div className="mt-1">
                    {getStatusIcon()}
                </div>
                <div className="display-flex flex-col gap-3 items-start flex-1">
                    {/* Title */}
                    <div className="display-flex flex-row items-center gap-3 w-full min-w-0">
                        <div className={`${connectionStatus === 'connected' ? 'font-color-secondary' : 'font-color-tertiary'} text-lg`}>
                            {getTitle()}
                        </div>
                        <div className="flex-1"/>
                        <div className="font-color-tertiary text-base">
                            {connectionStatus === 'connected' && `${totalFiles.toLocaleString()} Files`}
                        </div>
                    </div>

                    {/* Progress bar and text */}
                    {totalFiles > 0 && connectionStatus === 'connected' && (
                        <div className="w-full">
                            <ProgressBar progress={overallProgress} />
                            <div className="display-flex flex-row gap-4">
                                <div className="font-color-tertiary text-base">
                                    {getStatusText()}
                                </div>
                                <div className="flex-1"/>
                                <div className="font-color-tertiary text-base">
                                    {`${overallProgress.toFixed(1)}%`}
                                </div>
                            </div>
                        </div>
                    )}
                    
                    {/* {totalFiles === 0 && (
                        <div className="font-color-tertiary text-base w-full">
                            No files to process
                        </div>
                    )} */}
                </div>
            </div>

            {/* Failed uploads */}
            {connectionStatus === 'connected' && fileStats.uploadFailedCount > 0 && (
                <PaginatedFailedUploadsList
                    statuses={["failed"]}
                    count={fileStats.uploadFailedCount}
                    icon={AlertIcon}
                    title={`Failed upload${fileStats.uploadFailedCount > 1 ? 's' : ''}`}
                    tooltipTitle="Failed Uploads"
                    textColorClassName="font-color-red"
                    retryButton={true}
                />
            )}

            {connectionStatus === 'connected' && (fileStats.failedProcessingCount > 0 || fileStats.planLimitProcessingCount > 0) && (
                <div className="display-flex flex-col gap-3">
                    {/* Failed processing */}
                    {fileStats.failedProcessingCount > 0 && (
                        <PaginatedFailedProcessingList
                            statuses={["failed_user", "failed_system"]}
                            count={fileStats.failedProcessingCount}
                            title={`Failed processing`}
                            tooltipTitle="Processing errors"
                            tooltipContent={<FailedProcessingTooltipContent />}
                            icon={AlertIcon}
                            textColorClassName="font-color-red"
                        />
                    )}

                    {/* Skipped files (combined from upload and processing) */}
                    {fileStats.planLimitProcessingCount > 0 && (
                        <PaginatedFailedProcessingList
                            statuses={["plan_limit"]}
                            count={fileStats.planLimitProcessingCount}
                            title={`Skipped file${fileStats.planLimitProcessingCount > 1 ? 's' : ''}`}
                            tooltipTitle="Reasons"
                            tooltipContent={<SkippedProcessingTooltipContent />}
                            icon={InformationCircleIcon}
                            textColorClassName="font-color-secondary"
                        />
                    )}
                </div>
            )}
        </div>
    );
};

export default FileStatusDisplay;