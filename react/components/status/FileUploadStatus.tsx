import React, { useState, useEffect, useCallback } from "react";
import { Icon, RepeatIcon, AlertIcon, ArrowRightIcon, ArrowDownIcon } from "../icons/icons";
import IconButton from "../ui/IconButton";
import { useAtomValue } from "jotai";
import Button from "../ui/Button";
import { StepTwoIcon, CancelIcon, CheckmarkIcon, SpinnerIcon } from "./icons";
import { ProgressBar } from "./ProgressBar";
import { userIdAtom } from "../../atoms/auth";
import { FileHashReference } from "../../types/zotero";
import { logger } from "../../../src/utils/logger";
import ZoteroAttachmentList from "../ui/ZoteroAttachmentList";
import { resetFailedUploads } from "../../../src/services/FileUploader";
import { useUploadProgress } from "../../hooks/useUploadProgress";
import { uploadStatsAtom, uploadErrorAtom, uploadProgressAtom, isUploadCompleteAtom } from '../../atoms/status';

const ITEMS_PER_PAGE = 10;

const FileUploadStatus: React.FC<{ pollingInterval?: number}> = ({pollingInterval=1500}) => {
    const [showFailedFiles, setShowFailedFiles] = useState(false);
    const userId = useAtomValue(userIdAtom);
    const [failedAttachmentFiles, setFailedAttachmentFiles] = useState<FileHashReference[]>([]);
    const [currentPage, setCurrentPage] = useState(0);
    const [hasMoreFailed, setHasMoreFailed] = useState(false);
    const [isLoadingFailed, setIsLoadingFailed] = useState(false);

    // Upload status atoms
    const uploadStats = useAtomValue(uploadStatsAtom);
    const uploadError = useAtomValue(uploadErrorAtom);
    const uploadProgress = useAtomValue(uploadProgressAtom);
    const isUploadComplete = useAtomValue(isUploadCompleteAtom);

    // Upload progress hook
    useUploadProgress(
        {
            interval: pollingInterval,
            autoStop: false,
            onComplete: () => {},
            onError: (error: any) => {
                logger('Upload progress polling error:', error);
            }
        }
    );

    const fetchFailedUploads = useCallback(async (page: number) => {
        if (!userId || isLoadingFailed) return;

        setIsLoadingFailed(true);
        try {
            const result = await Zotero.Beaver.db.getFailedAttachmentsPaginated(userId, ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);
            const newFailedFiles = result.attachments.map((attachment) => {
                return {
                    file_hash: attachment.file_hash,
                    library_id: attachment.library_id,
                    zotero_key: attachment.zotero_key
                } as FileHashReference;
            });

            setFailedAttachmentFiles(prevFiles => page === 0 ? newFailedFiles : [...prevFiles, ...newFailedFiles]);
            setHasMoreFailed(result.has_more);
            setCurrentPage(page);
        } catch (error) {
            logger(`FileUploadStatus: Error fetching failed uploads: ${error}`);
            setFailedAttachmentFiles([]);
            setHasMoreFailed(false);
        } finally {
            setIsLoadingFailed(false);
        }
    }, [userId, isLoadingFailed]);

    // Effect to reset failed files when uploadStats.failed becomes 0 or user changes
    useEffect(() => {
        if ((uploadStats && uploadStats.failed === 0) || !userId) {
            setFailedAttachmentFiles([]);
            setCurrentPage(0);
            setHasMoreFailed(false);
            setShowFailedFiles(false);
        }
    }, [uploadStats?.failed, userId]);

    // Update hasMoreFailed when the total failed count changes
    useEffect(() => {
        // Re-evaluate hasMoreFailed when the total failed count changes
        if (showFailedFiles && uploadStats && uploadStats.failed > 0) {
            const currentlyFetchedCount = failedAttachmentFiles.length;
            const totalFailedCount = uploadStats.failed;
            
            // If total count exceeds what we've fetched, there might be more pages
            if (totalFailedCount > currentlyFetchedCount) {
                setHasMoreFailed(true);
            }
        }
    }, [uploadStats?.failed, failedAttachmentFiles.length, showFailedFiles]);

    const handleToggleShowFailedFiles = () => {
        const newShowFailedFiles = !showFailedFiles;
        setShowFailedFiles(newShowFailedFiles);
        if (newShowFailedFiles && failedAttachmentFiles.length === 0 && uploadStats && uploadStats.failed > 0) {
            // Fetch initial page when opening for the first time and there are failed uploads
            fetchFailedUploads(0);
        } else if (!newShowFailedFiles) {
            // Reset when closing, or retain state???
            // setFailedAttachmentFiles([]);
            // setCurrentPage(0);
            // setHasMoreFailed(false);
        }
    };

    const handleShowMoreFailed = () => {
        if (hasMoreFailed && !isLoadingFailed) {
            fetchFailedUploads(currentPage + 1);
        }
    };

    const getUploadIcon = (): React.ReactNode => {
        if (!uploadStats) return StepTwoIcon;
        if (!uploadStats.completed && !uploadStats.failed && !uploadStats.skipped) return StepTwoIcon;

        // Use upload stats from hook
        if (uploadStats) {
            if (uploadStats.failed > 0) return CancelIcon;
            if (isUploadComplete) return CheckmarkIcon;
        }
        
        if (uploadError) return CancelIcon;
        return SpinnerIcon;
    };

    const getUploadLeftText = (): string => {
        if (uploadStats === null  || uploadStats === undefined || !uploadStats) return "Waiting to upload...";
        
        const textParts: string[] = [];
        if (uploadStats.total > 0) textParts.push(`${uploadStats.completed.toLocaleString()} done`);
        if (uploadStats.failed > 0) textParts.push(`${uploadStats.failed.toLocaleString()} failed`);
        if (uploadStats.skipped > 0) textParts.push(`${uploadStats.skipped.toLocaleString()} skipped`);
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
                        <div className={`${uploadStats?.failed && uploadStats.failed > 0 ? 'font-color-red' : 'font-color-secondary'} text-lg`}>
                            File Uploads
                        </div>
                        <div className="flex-1"/>
                        {uploadStats && (
                            <div className="font-color-tertiary text-base">
                                {uploadStats.total.toLocaleString()} Files
                            </div>
                        )}
                    </div>

                    {/* Progress bar and text */}
                    <div className="w-full">
                        <ProgressBar progress={uploadProgress} />
                        <div className="display-flex flex-row gap-4">
                            {uploadStats !== null && uploadStats !== undefined && uploadStats.completed > 0 && (
                                <div className="font-color-tertiary text-base">
                                    {getUploadLeftText()}
                                </div>
                                // <div className="display-flex flex-row gap-3">
                                //     <StatusItem icon={ClockIcon} count={uploadStats.queued} textClassName="text-base" iconClassName="scale-90" />
                                //     <StatusItem icon={SyncIcon} count={uploadStats.processing} textClassName="text-base" iconClassName={syncIconClassName} />
                                //     <StatusItem icon={CheckmarkCircleIcon} count={uploadStats.completed} textClassName="text-base" iconClassName="scale-90 text-green-500" />
                                //     <StatusItem icon={CancelCircleIcon} count={uploadStats.failed} textClassName="text-base" iconClassName="scale-90 text-red-500" />
                                // </div>

                            )}
                            <div className="flex-1"/>
                            <div className="font-color-tertiary text-base">
                                {`${Math.min(uploadProgress, 100).toFixed(1)}%`}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            {/* Failed uploads */}
            {uploadStats !== null && uploadStats !== undefined && typeof uploadStats.failed === 'number' && uploadStats.failed > 0 && (
                <div className="display-flex flex-col gap-4 min-w-0">
                    <div className="display-flex flex-row gap-4  min-w-0">
                        {/* Icon */}
                        <div className="flex-shrink-0">
                            <Icon icon={AlertIcon} className="scale-12 mt-15 font-color-secondary" />
                        </div>
                        
                        {/* Failed count and retry button */}
                        <div className="display-flex flex-col items-start gap-3 w-full min-w-0">
                            <div className="display-flex flex-row items-start gap-3 w-full">
                                
                                {/* <div className={`flex-1 text-base font-medium`}>
                                    {uploadStats?.failed} failed uploads
                                </div> */}
                                <Button
                                    variant="ghost"
                                    onClick={handleToggleShowFailedFiles}
                                    rightIcon={showFailedFiles ? ArrowDownIcon : ArrowRightIcon}
                                    iconClassName="mr-0 mt-015 scale-12"
                                >
                                    <span className="text-base" style={{ marginLeft: '-3px' }}>
                                        {uploadStats?.failed.toLocaleString()} Failed Uploads
                                    </span>
                                </Button>
                                <div className="flex-1"/>
                                <div className="flex-shrink-0 display-flex flex-row gap-3">
                                    <IconButton
                                        variant="ghost"
                                        onClick={async () => {
                                            await resetFailedUploads();
                                            setShowFailedFiles(false);
                                        }}
                                        icon={RepeatIcon}
                                        iconClassName="font-color-secondary"
                                        className="scale-11"
                                    />
                                    {/* <Button
                                        variant="outline"
                                        onClick={() => {}}
                                    >
                                        Retry
                                    </Button> */}
                                </div>

                            </div>
                            {/* Failed files list */}
                            {showFailedFiles && (
                                <div className="display-flex flex-col gap-2 w-full">
                                    <ZoteroAttachmentList
                                        attachments={failedAttachmentFiles}
                                        maxHeight="250px"
                                        // button={<Button variant="outline" onClick={() => {}}>Retry</Button>}
                                        // onRetry={() => {}}
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


export default FileUploadStatus;