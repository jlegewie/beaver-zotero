import React, { useState, useEffect } from "react";
import { Icon, RepeatIcon, AlertIcon, ArrowRightIcon, ArrowDownIcon } from "../icons/icons";
import IconButton from "../ui/IconButton";
import { librarySyncProgressAtom } from "../../atoms/sync";
import { useAtomValue } from "jotai";
import Button from "../ui/Button";
import { StepTwoIcon, CancelIcon, CheckmarkIcon, SpinnerIcon } from "../status/icons";
import { ProgressBar } from "../status/ProgressBar";
import { userIdAtom } from "../../atoms/auth";
import { FileHashReference } from "../../types/zotero";
import { logger } from "../../../src/utils/logger";
import ZoteroAttachmentList from "../ui/ZoteroAttachmentList";
import { resetFailedUploads } from "../../../src/services/FileUploader";
import { useUploadProgress } from "../../hooks/useUploadProgress";
import { uploadStatsAtom, uploadErrorAtom, uploadProgressAtom, isUploadCompleteAtom } from '../../atoms/status';


const FileUploadStatus: React.FC<{isOnboardingPage?: boolean, pollingInterval?: number}> = ({isOnboardingPage=false, pollingInterval=1500}) => {
    const librarySyncProgress = useAtomValue(librarySyncProgressAtom);
    const [showFailedFiles, setShowFailedFiles] = useState(false);
    const userId = useAtomValue(userIdAtom);
    const [failedAttachmentFiles, setFailedAttachmentFiles] = useState<FileHashReference[]>([]);

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

    // Effect to fetch failed uploads when the failed count changes
    useEffect(() => {
        const fetchFailedUploads = async () => {
            if (!uploadStats?.failed || uploadStats.failed === 0 || !userId) {
                setFailedAttachmentFiles([]);
                return;
            }

            try {
                // Get failed attachments from database
                const attachments = await Zotero.Beaver.db.getFailedAttachments(userId);
                const failedAttachmentFiles = attachments.map((attachment) => {
                    return {
                        file_hash: attachment.file_hash,
                        library_id: attachment.library_id,
                        zotero_key: attachment.zotero_key
                    } as FileHashReference;
                });
                setFailedAttachmentFiles(failedAttachmentFiles);
            } catch (error) {
                logger(`FileUploadStatus: Error fetching failed uploads: ${error}`);
                setFailedAttachmentFiles([]);
            }
        };

        fetchFailedUploads();
    }, [uploadStats?.failed, userId]); // Dependency on failed count

    const getUploadIcon = (): React.ReactNode => {
        // Onboarding page: Ensure library sync is complete
        if (isOnboardingPage && librarySyncProgress.anyFailed) return StepTwoIcon;
        if (isOnboardingPage && librarySyncProgress.progress < 100) return StepTwoIcon;

        // Use upload stats from hook
        if (uploadStats) {
            if (uploadStats.failed > 0) return CancelIcon;
            if (isUploadComplete) return CheckmarkIcon;
        }
        
        if (uploadError) return CancelIcon;
        return SpinnerIcon;
    };

    const getUploadLeftText = (): string => {
        if (!uploadStats) return "";
        
        const textParts: string[] = [];
        if (uploadStats.total > 0) textParts.push(`${uploadStats.completed.toLocaleString()} completed`);
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
                        <div className="font-color-primary text-lg">Uploading files</div>
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
                            {uploadStats && uploadStats?.completed && (
                                <div className="font-color-tertiary text-base">
                                    {getUploadLeftText()}
                                    {/* {`${uploadStats?.completed.toLocaleString()} completed`} */}
                                </div>
                            )}
                            <div className="flex-1"/>
                            <div className="font-color-tertiary text-base">
                                {`${Math.min(uploadProgress, 100).toFixed(0)}%`}
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
                            <Icon icon={AlertIcon} className="scale-12 mt-15 font-color-red" />
                        </div>
                        
                        {/* Failed count and retry button */}
                        <div className="display-flex flex-col items-start gap-3 w-full min-w-0">
                            <div className="display-flex flex-row items-start gap-3 w-full">
                                
                                {/* <div className={`flex-1 text-base font-medium font-color-red`}>
                                    {uploadStats?.failed} failed uploads
                                </div> */}
                                <Button
                                    variant="ghost"
                                    onClick={() => setShowFailedFiles(!showFailedFiles)}
                                    rightIcon={showFailedFiles ? ArrowDownIcon : ArrowRightIcon}
                                    iconClassName="mr-0 mt-015 scale-12 font-color-red"
                                >
                                    <span className="text-base font-color-red" style={{ marginLeft: '-3px' }}>
                                        {uploadStats?.failed.toLocaleString()} Failed Uploads
                                    </span>
                                </Button>
                                <div className="flex-1"/>
                                <div className="flex-shrink-0 display-flex flex-row gap-3">
                                    <IconButton
                                        variant="ghost"
                                        onClick={async () => {
                                            await resetFailedUploads();
                                        }}
                                        icon={RepeatIcon}
                                        iconClassName={`font-color-red`}
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
                                <ZoteroAttachmentList
                                    attachments={failedAttachmentFiles}
                                    maxHeight="250px"
                                    // button={<Button variant="outline" onClick={() => {}}>Retry</Button>}
                                    // onRetry={() => {}}
                                />
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};


export default FileUploadStatus;