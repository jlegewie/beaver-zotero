import React, { useMemo, useState, useEffect } from "react";
import { useAtomValue } from "jotai";
import { CheckmarkIcon, SpinnerIcon, CheckmarkIconGrey, AlertIcon as AlertIconIcon } from "./icons";
import { AlertIcon, ArrowDownIcon, ArrowRightIcon, Icon, InformationCircleIcon } from "../icons/icons";
import { ProgressBar } from "./ProgressBar";
import { fileStatusSummaryAtom } from "../../atoms/files";
import { fileUploaderBackoffUntilAtom } from "../../atoms/sync";
import { FailedProcessingTooltipContent } from "./FailedProcessingTooltipContent";
import PaginatedFailedProcessingList from "./PaginatedFailedProcessingList";
import { SkippedFilesSummary } from "./SkippedFilesSummary";
import PaginatedFailedUploadsList from "./PaginatedFailedUploadsList";
import { ConnectionStatus } from "../../hooks/useFileStatus";
import { planFeaturesAtom } from "../../atoms/profile";
import Button from "../ui/Button";
import { zoteroServerCredentialsErrorAtom, zoteroServerDownloadErrorAtom } from "../../atoms/ui";

interface FileStatusDisplayProps {
    connectionStatus: ConnectionStatus;
}

const useTimeRemaining = (targetTime: number | null) => {
    const [remaining, setRemaining] = useState<number | null>(null);

    useEffect(() => {
        if (targetTime === null) {
            setRemaining(null);
            return;
        }

        // Add safety check for valid timestamps
        if (targetTime <= Date.now()) {
            setRemaining(0);
            return;
        }

        const interval = setInterval(() => {
            const now = Date.now();
            const newRemaining = Math.max(0, Math.ceil((targetTime - now) / 1000));
            setRemaining(newRemaining);
            if (newRemaining === 0) {
                clearInterval(interval);
            }
        }, 1000);

        // Immediate cleanup on unmount
        return () => {
            clearInterval(interval);
            setRemaining(null);
        };
    }, [targetTime]);

    return remaining;
};


const FileStatusDisplay: React.FC<FileStatusDisplayProps> = ({ connectionStatus }) => {
    const fileStats = useAtomValue(fileStatusSummaryAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);
    const backoffUntil = useAtomValue(fileUploaderBackoffUntilAtom);
    const timeRemaining = useTimeRemaining(backoffUntil);
    const zoteroServerDownloadError = useAtomValue(zoteroServerDownloadErrorAtom);
    const zoteroServerCredentialsError = useAtomValue(zoteroServerCredentialsErrorAtom);
    const [showSkippedFiles, setShowSkippedFiles] = useState(false);

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
        
        if (backoffUntil && timeRemaining !== null && timeRemaining > 0) {
            return `Retrying uploads in ${timeRemaining}s...`;
        }

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

    const processingTier = useMemo(() => planFeatures.processingTier, [planFeatures.processingTier]);

    const skippedFilesCount = fileStats.planLimitProcessingCount;

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

            {/* Skipped uploads (only shown if the user has no processing tier) */}
            {processingTier === 'none' && fileStats.uploadPlanLimitCount > 0 && (
                <PaginatedFailedUploadsList
                    statuses={["plan_limit"]}
                    count={fileStats.uploadPlanLimitCount}
                    icon={AlertIcon}
                    title={`Skipped upload${fileStats.uploadPlanLimitCount > 1 ? 's' : ''}`}
                    tooltipTitle="Skipped Uploads"
                    textColorClassName="font-color-secondary"
                />
            )}

            {/* Failed and skipped processing (only shown if the user has a processing tier) */}
            {processingTier !== 'none' && connectionStatus === 'connected' && (fileStats.failedProcessingCount > 0 || skippedFilesCount > 0) && (
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
                    {skippedFilesCount > 0 && (
                        <div className="display-flex flex-col gap-4 min-w-0">
                            <div className="display-flex flex-row gap-4 min-w-0">
                                <div className="flex-shrink-0">
                                    <Icon icon={InformationCircleIcon} className={`scale-12 mt-15 font-color-secondary`} />
                                </div>
                                <div className="display-flex flex-col items-start gap-3 w-full min-w-0">
                                    <div className="display-flex flex-row items-start gap-3 w-full">
                                        <Button
                                            variant="ghost"
                                            onClick={() => setShowSkippedFiles(prev => !prev)}
                                            rightIcon={showSkippedFiles ? ArrowDownIcon : ArrowRightIcon}
                                            iconClassName={`mr-0 mt-015 scale-12 font-color-secondary`}
                                        >
                                            <span className={`text-base font-color-secondary`} style={{ marginLeft: '-3px' }}>
                                                {skippedFilesCount.toLocaleString()} Skipped file{skippedFilesCount > 1 ? 's' : ''}
                                            </span>
                                        </Button>
                                    </div>
                                    {showSkippedFiles && <SkippedFilesSummary />}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Zotero server credentials error */}
            {connectionStatus === 'connected' && fileStats.uploadFailedCount > 0 && zoteroServerCredentialsError && (
                <div className="font-color-tertiary text-sm">
                    Some uploads failed because the user is not logged in to Zotero. Please log in to Zotero and try again.
                </div>
            )}

            {/* Zotero server download error */}
            {connectionStatus === 'connected' && fileStats.uploadFailedCount > 0 && !zoteroServerCredentialsError && zoteroServerDownloadError && (
                <div className="font-color-tertiary text-sm">
                    Some uploads failed because they could not be downloaded from Zotero's server. Please try again later.
                </div>
            )}

        </div>
    );
};

export default FileStatusDisplay;