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
    const backoffUntil = useAtomValue(fileUploaderBackoffUntilAtom);
    const timeRemaining = useTimeRemaining(backoffUntil);
    const zoteroServerDownloadError = useAtomValue(zoteroServerDownloadErrorAtom);
    const zoteroServerCredentialsError = useAtomValue(zoteroServerCredentialsErrorAtom);
    const [showSkippedFiles, setShowSkippedFiles] = useState(false);

    if (connectionStatus == 'connected' && (!fileStats || !fileStats.fileStatusAvailable)) connectionStatus='connecting';

    // // Overall progress calculation
    const fullyCompleteFiles = fileStats.unsupportedFileCount + fileStats.completedFiles;
    // // Determine if everything is complete
    const isComplete = fileStats.activeCount === 0 && fileStats.queuedProcessingCount === 0;
    
    // Determine icon
    const getStatusIcon = (): React.ReactNode => {
        if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting' || connectionStatus === 'polling') return SpinnerIcon;
        if (connectionStatus === 'error' || connectionStatus === 'idle' || connectionStatus === 'disconnected') return AlertIconIcon;
        if (fileStats.totalFiles === 0) return CheckmarkIconGrey;
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
        
        if (fileStats.activeCount > 0) {
            textParts.push(`${fileStats.activeCount.toLocaleString()} in progress`);
        }

        if (textParts.length === 0 && fileStats.queuedProcessingCount > 0) {
            textParts.push(`${fileStats.queuedProcessingCount.toLocaleString()} queued`);
        }
        
        if (textParts.length === 0) {
            if (fileStats.totalFiles === 0) return "No files";
            return "";
        }
        
        return textParts.join(", ");
    };

    const getTitle = (): string => {
        if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') return "Connecting...";
        if (connectionStatus === 'error' || connectionStatus === 'idle' || connectionStatus === 'disconnected') return "Unable to connect...";
        if (fileStats.totalFiles === 0) return "No files to process";
        return "File Processing";
    };

    // Skipped files combine invalid files (Category 2) and plan limit (Category 4)
    const skippedFilesCount = fileStats.planLimitCount + fileStats.failedUserCount;

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
                            {connectionStatus === 'connected' && `${fileStats.totalFiles.toLocaleString()} Files`}
                        </div>
                    </div>

                    {/* Progress bar and text */}
                    {fileStats.totalFiles > 0 && connectionStatus === 'connected' && (
                        <div className="w-full">
                            <ProgressBar progress={fileStats.progress} />
                            <div className="display-flex flex-row gap-4">
                                <div className="font-color-tertiary text-base">
                                    {getStatusText()}
                                </div>
                                <div className="flex-1"/>
                                <div className="font-color-tertiary text-base">
                                    {`${fileStats.progress.toFixed(1)}%`}
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

            {/* File upload and processing errors */}
            {connectionStatus === 'connected' && (
                <div className="display-flex flex-col gap-3">

                    {/* Category 1: Temporary upload error */}
                    {fileStats.failedUploadCount > 0 && (
                        <PaginatedFailedProcessingList
                            statuses={["failed_upload"]}
                            count={fileStats.failedUploadCount}
                            icon={AlertIcon}
                            title={`Failed upload${fileStats.failedUploadCount > 1 ? 's' : ''}`}
                            tooltipTitle="Failed Uploads. Retry to upload again."
                            textColorClassName="font-color-red"
                            retryUploadsButton={true}
                        />
                    )}

                    {/* Category 3: System processing error */}
                    {fileStats.failedSystemCount > 0 && (
                        <PaginatedFailedProcessingList
                            statuses={["failed_system"]}
                            count={fileStats.failedSystemCount}
                            title={`Failed processing`}
                            tooltipTitle="Processing errors"
                            tooltipContent={<FailedProcessingTooltipContent />}
                            icon={AlertIcon}
                            textColorClassName="font-color-red"
                        />
                    )}

                    {/* Skipped files
                      * 
                      * - Category 2: Invalid file
                      * - Category 4: Plan limit
                      * 
                      */}
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

                    {/* Zotero server credentials error */}
                    {fileStats.uploadFailedCount > 0 && zoteroServerCredentialsError && (
                        <div className="font-color-tertiary text-sm">
                            Some uploads failed because the user is not logged in to Zotero. Please log in to Zotero and try again.
                        </div>
                    )}

                    {/* Zotero server download error */}
                    {fileStats.uploadFailedCount > 0 && !zoteroServerCredentialsError && zoteroServerDownloadError && (
                        <div className="font-color-tertiary text-sm">
                            Some uploads failed because they could not be downloaded from Zotero's server. Please try again later.
                        </div>
                    )}
                </div>
            )}

            {/* Page balance warning */}
            {connectionStatus === 'connected' && fileStats.pageBalanceExhausted && (
                <div className="font-color-tertiary display-flex flex-row gap-3 items-start">
                    <Icon icon={AlertIcon} className="scale-11 mt-020" />
                    <div className="items-start display-flex flex-col gap-2">
                        <span>File processing limit reached</span>
                        <span className="text-sm">
                            You've hit the 125,000-page processing limit for the beta.
                            Some files weren't processed. Limits will change after the beta.
                        </span>
                    </div>
                </div>
            )}

        </div>
    );
};

export default FileStatusDisplay;