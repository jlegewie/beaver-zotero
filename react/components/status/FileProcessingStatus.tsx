import React, { useState, useEffect, useCallback } from "react";
import { Icon, AlertIcon, ArrowRightIcon, ArrowDownIcon } from "../icons/icons";
import IconButton from "../ui/IconButton";
import { librarySyncProgressAtom } from "../../atoms/sync";
import { useAtomValue } from "jotai";
import Button from "../ui/Button";
import { StepThreeIcon, CancelIcon, CheckmarkIcon, SpinnerIcon } from "./icons";
import { ProgressBar } from "./ProgressBar";
import { userIdAtom } from "../../atoms/auth";
import { FailedFileReference } from "../../types/zotero";
import { logger } from "../../../src/utils/logger";
import ZoteroAttachmentList from "../ui/ZoteroAttachmentList";
import { attachmentsService } from "../../../src/services/attachmentsService";
import { fileStatusStatsAtom } from "../../atoms/ui";
import { planFeaturesAtom } from "../../atoms/profile";
import { AttachmentStatusPagedResponse } from "../../../src/services/attachmentsService";
import { uploadStatsAtom, isUploadCompleteAtom } from "../../atoms/status";
import Tooltip from "../ui/Tooltip";
import { FailedProcessingTooltipContent } from "./FailedProcessingTooltipContent";


const ITEMS_PER_PAGE = 10;

export const errorMapping = {
    "encrypted": "File is encrypted",
    "no_text_layer": "Requires OCR",
    "insufficient_text": "Unknown error",
    "file_missing": "Unknown error",
    "download_failed": "Unknown error",
    "preprocessing_failed": "Unknown error",
    "conversion_failed": "Unknown error",
    "opening_failed": "Unknown error",
    "upload_failed": "Unknown error",
    "chunk_failed": "Unknown error",
    "embedding_failed": "Unknown error",
    "db_update_failed": "Unknown error",
    "task_parsing_failed": "Unknown error",
    "max_retries": "Unknown error",
    "unexpected_error": "Unknown error"
};

const FileProcessingStatus: React.FC<{isOnboardingPage?: boolean}> = ({isOnboardingPage=false}) => {
    const librarySyncProgress = useAtomValue(librarySyncProgressAtom);
    const uploadStats = useAtomValue(uploadStatsAtom);
    const isUploadComplete = useAtomValue(isUploadCompleteAtom);

    const [showFailedFiles, setShowFailedFiles] = useState(false);
    const userId = useAtomValue(userIdAtom);
    const [failedAttachmentFiles, setFailedAttachmentFiles] = useState<FailedFileReference[]>([]);
    const [currentPage, setCurrentPage] = useState(0);
    const [hasMoreFailed, setHasMoreFailed] = useState(false);
    const [isLoadingFailed, setIsLoadingFailed] = useState(false);

    // File processing status
    // useFileStatus(); // This hook updates fileStatusAtom and should run from the parent component
    const fileStats = useAtomValue(fileStatusStatsAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);

    const fetchFailedProcessingItems = useCallback(async (page: number) => {
        if (!userId || isLoadingFailed) return;

        setIsLoadingFailed(true);
        try {
            const useAdvancedPipeline = planFeatures.advancedProcessing;
            const result: AttachmentStatusPagedResponse = await attachmentsService.getFailedAttachments(
                useAdvancedPipeline,
                page + 1, // API is 1-based
                ITEMS_PER_PAGE 
            );
            
            const newFailedFiles = result.items.map((item) => {
                return {
                    file_hash: item.file_hash || '', // Ensure file_hash is always a string
                    library_id: item.library_id,
                    zotero_key: item.zotero_key,
                    errorCode: useAdvancedPipeline ? item.docling_error_code : item.md_error_code,
                } as FailedFileReference;
            });

            setFailedAttachmentFiles(prevFiles => page === 0 ? newFailedFiles : [...prevFiles, ...newFailedFiles]);
            setHasMoreFailed(result.has_more);
            setCurrentPage(page);
        } catch (error) {
            logger(`FileProcessingStatus: Error fetching failed processing items: ${error}`);
            setFailedAttachmentFiles([]);
            setHasMoreFailed(false);
        } finally {
            setIsLoadingFailed(false);
        }
    }, [userId, planFeatures.advancedProcessing]);

    // Effect to manage fetching and clearing failed files based on relevant state changes
    useEffect(() => {
        // If no user, clear and hide
        if (!userId) {
            setFailedAttachmentFiles([]);
            setCurrentPage(0);
            setHasMoreFailed(false);
            setShowFailedFiles(false);
            return;
        }

        // If no failed items, clear and hide
        if (fileStats && fileStats.failedProcessingCount === 0) {
            setFailedAttachmentFiles([]);
            setCurrentPage(0);
            setHasMoreFailed(false);
            setShowFailedFiles(false); 
            return;
        }

        // If the section is visible and there are failed items, refresh data from page 0
        // This handles:
        // - Initial display when toggled open
        // - Updates if failedProcessingCount changes while visible
        // - Updates if userId or planFeatures.advancedProcessing changes while visible (due to fetchFailedProcessingItems dependency)
        if (showFailedFiles && fileStats && fileStats.failedProcessingCount > 0) {
            fetchFailedProcessingItems(0); 
        }
    }, [userId, fileStats?.failedProcessingCount, showFailedFiles, fetchFailedProcessingItems]);

    const handleToggleShowFailedFiles = () => {
        setShowFailedFiles(prevShow => !prevShow);
        // The useEffect above will now handle fetching or clearing based on the new showFailedFiles state
    };

    const handleShowMoreFailed = () => {
        if (hasMoreFailed && !isLoadingFailed) {
            fetchFailedProcessingItems(currentPage + 1);
        }
    };

    const handleRetryFailedProcessing = async () => {
        if (!userId) return;
        logger(`FileProcessingStatus: Retrying all failed processing items for user ${userId}, pipeline: ${planFeatures.advancedProcessing ? 'advanced' : 'basic'}`);
        try {
            // Placeholder for actual retry mechanism.
            // This might involve a backend call like:
            // await attachmentsService.retryAllFailedProcessing(userId, planFeatures.docling_enabled);
            // For now, we'll just clear the local list and re-fetch to simulate.
            setShowFailedFiles(false);
            setFailedAttachmentFiles([]);
            setCurrentPage(0);
            setHasMoreFailed(false);
            // Optionally, trigger a re-evaluation of fileStats by interacting with its source if possible,
            // or rely on the next realtime update from useFileStatus.
            // If there was a specific atom to trigger a refetch for useFileStatus, it would be called here.
            logger('FileProcessingStatus: Retry initiated (simulated). Realtime updates should reflect changes.');

        } catch (error) {
            logger(`FileProcessingStatus: Error retrying failed processing items: ${error}`);
        }
    };

    const getProcessingIcon = (): React.ReactNode => {
        // Onboarding page: Ensure library sync and uploads are complete
        if (isOnboardingPage) {
            if (librarySyncProgress.anyFailed) return StepThreeIcon;
            if (librarySyncProgress.progress < 100) return StepThreeIcon;
            if (uploadStats && uploadStats.failed > 0) return StepThreeIcon;
            if (!isUploadComplete) return StepThreeIcon;
        }

        // Use file processing stats
        if (fileStats) {
            if (fileStats.failedProcessingCount > 0) return CancelIcon;
            if (fileStats.progress >= 100 && fileStats.activeProcessingCount === 0 && fileStats.queuedProcessingCount === 0) return CheckmarkIcon;
        }
        
        return SpinnerIcon; // Default to spinner if still processing or stats are unavailable
    };

    const getProcessingLeftText = (): string => {
        if (!fileStats) return "Loading status...";
        
        const textParts: string[] = [];
        if (fileStats.completedFiles > 0) textParts.push(`${fileStats.completedFiles.toLocaleString()} done`);
        if (fileStats.failedProcessingCount > 0) textParts.push(`${fileStats.failedProcessingCount.toLocaleString()} failed`);
        if (fileStats.activeProcessingCount > 0) textParts.push(`${fileStats.activeProcessingCount.toLocaleString()} active`);
        // if (fileStats.queuedProcessingCount > 0) textParts.push(`${fileStats.queuedProcessingCount.toLocaleString()} queued`);
        
        if (textParts.length === 0 && fileStats.totalFiles > 0) return "Waiting to process...";
        if (textParts.length === 0 && fileStats.totalFiles === 0) return "No files to process.";

        return textParts.join(", ");
    };
    
    return (
        <div className="display-flex flex-col gap-4 p-3 border-popup rounded-md bg-quinary min-w-0">
            <div className="display-flex flex-row gap-4">
                <div className="mt-1">
                    {getProcessingIcon()}
                </div>
                <div className="display-flex flex-col gap-3 items-start flex-1">

                    {/* Title */}
                    <div className="display-flex flex-row items-center gap-3 w-full min-w-0">
                        <div className={`${fileStats?.failedProcessingCount && fileStats.failedProcessingCount > 0 ? 'font-color-red' : 'font-color-secondary'} text-lg`}>
                            File Processing
                        </div>
                        <div className="flex-1"/>
                        {fileStats && (
                            <div className="font-color-tertiary text-base">
                                {fileStats.totalFiles.toLocaleString()} Files
                            </div>
                        )}
                    </div>

                    {/* Progress bar and text */}
                    {fileStats && fileStats.totalFiles > 0 && (
                        <div className="w-full">
                            <ProgressBar progress={fileStats.progress} />
                            <div className="display-flex flex-row gap-4">
                                <div className="font-color-tertiary text-base">
                                    {getProcessingLeftText()}
                                </div>
                                <div className="flex-1"/>
                                <div className="font-color-tertiary text-base">
                                    {`${Math.min(fileStats.progress, 100).toFixed(0)}%`}
                                </div>
                            </div>
                        </div>
                    )}
                     {fileStats && fileStats.totalFiles === 0 && (
                         <div className="font-color-tertiary text-base w-full">
                            {getProcessingLeftText()}
                        </div>
                     )}
                </div>
            </div>
            {/* Failed processing items */}
            {fileStats !== null && fileStats !== undefined && typeof fileStats.failedProcessingCount === 'number' && fileStats.failedProcessingCount > 0 && (
                <div className="display-flex flex-col gap-4 min-w-0">
                    <div className="display-flex flex-row gap-4  min-w-0">
                        {/* Icon */}
                        <div className="flex-shrink-0">
                            <Icon icon={AlertIcon} className="scale-12 mt-15 font-color-red" />
                        </div>
                        
                        {/* Failed count and retry button */}
                        <div className="display-flex flex-col items-start gap-3 w-full min-w-0">
                            <div className="display-flex flex-row items-start gap-3 w-full">
                                <Tooltip 
                                    content="Processing error codes"
                                    customContent={<FailedProcessingTooltipContent failedCount={fileStats.failedProcessingCount} />}
                                    showArrow={true}
                                    disabled={fileStats.failedProcessingCount === 0}
                                    placement="top"
                                >
                                    <Button
                                        variant="ghost"
                                        onClick={handleToggleShowFailedFiles}
                                        rightIcon={showFailedFiles ? ArrowDownIcon : ArrowRightIcon}
                                        iconClassName="mr-0 mt-015 scale-12 font-color-red"
                                    >
                                        <span className="text-base font-color-red" style={{ marginLeft: '-3px' }}>
                                            {fileStats.failedProcessingCount.toLocaleString()} Failed Items
                                        </span>
                                    </Button>
                                </Tooltip>
                                <div className="flex-1"/>
                                <div className="flex-shrink-0 display-flex flex-row gap-3">
                                    {/* <IconButton
                                        variant="ghost"
                                        onClick={handleRetryFailedProcessing}
                                        icon={RepeatIcon}
                                        iconClassName={`font-color-red`}
                                        className="scale-11"
                                    /> */}
                                </div>
                            </div>
                            {/* Failed files list */}
                            {showFailedFiles && (
                                <div className="display-flex flex-col gap-2 w-full">
                                    <ZoteroAttachmentList
                                        attachments={failedAttachmentFiles}
                                        maxHeight="250px"
                                    />
                                    {hasMoreFailed && (
                                        <Button
                                            variant="ghost"
                                            rightIcon={ArrowDownIcon}
                                            loading={isLoadingFailed}
                                            iconClassName={`scale-11 ${isLoadingFailed ? 'animate-spin' : ''}`}
                                            className="fit-content"
                                            onClick={handleShowMoreFailed}
                                            disabled={isLoadingFailed || !hasMoreFailed}
                                        >
                                            {isLoadingFailed ? "Loading..." : "Show More"}
                                        </Button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default FileProcessingStatus; 